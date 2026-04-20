using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Linux.Bluetooth;
using Linux.Bluetooth.Extensions;

namespace GymMotion.LinuxBleGateway;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            var config = Config.Parse(args);
            await using var gateway = new LinuxGatewayApp(config);
            await gateway.RunAsync();
            return 0;
        }
        catch (OperationCanceledException)
        {
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"[linux-gateway] fatal error: {error}");
            return 1;
        }
    }
}

internal sealed class LinuxGatewayApp : IAsyncDisposable
{
    private static readonly Guid RuntimeServiceUuid = ReadGuid("BLE_RUNTIME_SERVICE_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001");
    private static readonly Guid TelemetryUuid = ReadGuid("BLE_TELEMETRY_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002");
    private static readonly Guid ControlUuid = ReadGuid("BLE_CONTROL_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003");
    private static readonly Guid StatusUuid = ReadGuid("BLE_STATUS_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7004");
    private static readonly TimeSpan SessionLeaseTtl = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan LeaseInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(8);
    private static readonly IDictionary<string, object> WriteOptions =
        new Dictionary<string, object>(StringComparer.Ordinal);

    private readonly Config _config;
    private readonly IReadOnlyList<ApprovedNodeRule> _rules;
    private readonly HttpClient _httpClient = new();
    private readonly ConcurrentDictionary<string, RuleRuntime> _runtimeByRuleId = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private IAdapter1? _adapter;
    private IDisposable? _deviceWatcher;

    public LinuxGatewayApp(Config config)
    {
        _config = config;
        _rules = ApprovedNodeRule.Load(config.NodesFile);
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "gym-motion-linux-gateway-poc");
        _httpClient.DefaultRequestHeaders.Add("X-Gym-Motion-Gateway-Id", config.GatewayId);
    }

    public async Task RunAsync()
    {
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            _shutdown.Cancel();
        };

        _adapter = string.IsNullOrWhiteSpace(_config.AdapterName)
            ? (await BlueZManager.GetAdaptersAsync()).FirstOrDefault()
            : await BlueZManager.GetAdapterAsync(_config.AdapterName);

        if (_adapter is null)
        {
            throw new InvalidOperationException("No Bluetooth adapter was available on this Linux host.");
        }

        _deviceWatcher = await _adapter.WatchDevicesAddedAsync(device =>
        {
            _ = Task.Run(() => OnDeviceFoundAsync(device));
        });

        Log("scanner starting", new Dictionary<string, object?>
        {
            ["gatewayId"] = _config.GatewayId,
            ["adapter"] = _config.AdapterName ?? "default",
            ["approvedNodeCount"] = _rules.Count,
        });

        await _adapter.StartDiscoveryAsync();

        foreach (var device in await _adapter.GetDevicesAsync())
        {
            _ = Task.Run(() => OnDeviceFoundAsync(device));
        }

        try
        {
            await Task.Delay(Timeout.Infinite, _shutdown.Token);
        }
        finally
        {
            await _adapter.StopDiscoveryAsync();
            _deviceWatcher?.Dispose();
            await DisposeConnectionsAsync();
        }
    }

    private async Task OnDeviceFoundAsync(Device device)
    {
        var properties = await device.GetPropertiesAsync();
        var matchedRule = _rules.FirstOrDefault(rule => rule.Matches(properties));
        if (matchedRule is null)
        {
            return;
        }

        var runtime = _runtimeByRuleId.GetOrAdd(
            matchedRule.Id,
            _ => new RuleRuntime(matchedRule));
        runtime.Device = device;
        runtime.DeviceProperties = properties;

        if (!runtime.TryMarkConnecting())
        {
            return;
        }

        _ = Task.Run(() => RunConnectionLoopAsync(runtime, _shutdown.Token));
    }

    private async Task RunConnectionLoopAsync(RuleRuntime runtime, CancellationToken cancellationToken)
    {
        try
        {
            await ConnectAndStreamAsync(runtime, cancellationToken);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            Log("node connection failed", new Dictionary<string, object?>
            {
                ["ruleId"] = runtime.Rule.Id,
                ["label"] = runtime.Rule.Label,
                ["error"] = error.Message,
            });
        }
        finally
        {
            await runtime.DisposeClientAsync();
            runtime.MarkDisconnected();

            if (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(ReconnectDelay, cancellationToken);
            }
        }
    }

    private async Task ConnectAndStreamAsync(RuleRuntime runtime, CancellationToken cancellationToken)
    {
        var device = runtime.Device ?? throw new InvalidOperationException("No discovered device was available.");
        var properties = runtime.DeviceProperties ?? await device.GetPropertiesAsync();
        Log("connecting", new Dictionary<string, object?>
        {
            ["ruleId"] = runtime.Rule.Id,
            ["label"] = runtime.Rule.Label,
            ["address"] = NormalizeAddress(properties.Address),
            ["name"] = properties.Name,
        });

        runtime.Client = device;
        runtime.DisconnectSignal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        runtime.Client.Disconnected += (_, _) =>
        {
            runtime.DisconnectSignal.TrySetResult();
            return Task.CompletedTask;
        };
        await runtime.Client.ConnectAsync();
        await runtime.Client.WaitForPropertyValueAsync("Connected", true, ConnectTimeout);
        await runtime.Client.WaitForPropertyValueAsync("ServicesResolved", true, ConnectTimeout);

        Log("connected", new Dictionary<string, object?>
        {
            ["ruleId"] = runtime.Rule.Id,
            ["label"] = runtime.Rule.Label,
            ["address"] = NormalizeAddress(properties.Address),
        });

        var service = await runtime.Client.GetServiceAsync(RuntimeServiceUuid.ToString());
        if (service is null)
        {
            throw new InvalidOperationException($"Required GATT service {RuntimeServiceUuid} was not available.");
        }

        runtime.TelemetryCharacteristic = await service.GetCharacteristicAsync(TelemetryUuid.ToString());
        runtime.ControlCharacteristic = await service.GetCharacteristicAsync(ControlUuid.ToString());
        runtime.StatusCharacteristic = await service.GetCharacteristicAsync(StatusUuid.ToString());

        if (runtime.TelemetryCharacteristic is null ||
            runtime.ControlCharacteristic is null ||
            runtime.StatusCharacteristic is null)
        {
            throw new InvalidOperationException("One or more required runtime GATT characteristics were unavailable.");
        }

        await runtime.TelemetryCharacteristic.StartNotifyAsync();
        runtime.TelemetryCharacteristic.Value += (_, eventArgs) =>
            HandleTelemetryEventAsync(runtime, eventArgs);

        await BeginOrAdoptSessionAsync(runtime, cancellationToken);
        await ReadBootstrapTelemetryAsync(runtime, cancellationToken);
        var leaseTask = Task.Run(() => LeaseLoopAsync(runtime, cancellationToken), cancellationToken);

        try
        {
            await runtime.DisconnectSignal.Task.WaitAsync(cancellationToken);
        }
        finally
        {
            runtime.CancelSession();
            await leaseTask.WaitAsync(TimeSpan.FromSeconds(1));
        }
    }

    private async Task BeginOrAdoptSessionAsync(RuleRuntime runtime, CancellationToken cancellationToken)
    {
        var existingStatus = await ReadSessionStatusAsync(runtime, cancellationToken);
        if (existingStatus is not null &&
            string.Equals(existingStatus.Type, "app-session-online", StringComparison.Ordinal) &&
            !string.IsNullOrWhiteSpace(existingStatus.SessionId))
        {
            runtime.SessionId = existingStatus.SessionId;
            Log("adopted active session", new Dictionary<string, object?>
            {
                ["ruleId"] = runtime.Rule.Id,
                ["sessionId"] = existingStatus.SessionId,
                ["bootId"] = existingStatus.BootId,
            });
            return;
        }

        var sessionId = RandomHex(8);
        var sessionNonce = RandomHex(8);
        var payload = JsonSerializer.Serialize(new
        {
            type = "app-session-begin",
            sessionId,
            sessionNonce,
            expiresInMs = (int)SessionLeaseTtl.TotalMilliseconds,
        });

        await WriteControlAsync(runtime, payload, cancellationToken);

        var deadline = DateTimeOffset.UtcNow.AddSeconds(12);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var status = await ReadSessionStatusAsync(runtime, cancellationToken);
            if (status is not null &&
                string.Equals(status.Type, "app-session-online", StringComparison.Ordinal) &&
                string.Equals(status.SessionId, sessionId, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(status.SessionNonce, sessionNonce, StringComparison.OrdinalIgnoreCase))
            {
                runtime.SessionId = sessionId;
                Log("session established", new Dictionary<string, object?>
                {
                    ["ruleId"] = runtime.Rule.Id,
                    ["sessionId"] = sessionId,
                    ["bootId"] = status.BootId,
                });
                return;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken);
        }

        throw new InvalidOperationException("Session status verification failed.");
    }

    private async Task LeaseLoopAsync(RuleRuntime runtime, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, runtime.SessionCancellation.Token);
        while (!linked.IsCancellationRequested && !string.IsNullOrWhiteSpace(runtime.SessionId))
        {
            await Task.Delay(LeaseInterval, linked.Token);

            var payload = JsonSerializer.Serialize(new
            {
                type = "app-session-lease",
                sessionId = runtime.SessionId,
                expiresInMs = (int)SessionLeaseTtl.TotalMilliseconds,
            });

            await WriteControlAsync(runtime, payload, linked.Token);
        }
    }

    private async Task ReadBootstrapTelemetryAsync(RuleRuntime runtime, CancellationToken cancellationToken)
    {
        if (runtime.TelemetryCharacteristic is null)
        {
            return;
        }

        var bytes = await runtime.TelemetryCharacteristic.ReadValueAsync(ReadTimeout);
        await HandleTelemetryPayloadAsync(runtime, bytes, "bootstrap-read", cancellationToken);
    }

    private async Task<SessionStatus?> ReadSessionStatusAsync(RuleRuntime runtime, CancellationToken cancellationToken)
    {
        if (runtime.StatusCharacteristic is null)
        {
            return null;
        }

        var bytes = await runtime.StatusCharacteristic.ReadValueAsync(ReadTimeout);
        if (ParseJson(bytes) is not JsonElement payload)
        {
            return null;
        }

        return new SessionStatus(
            Type: GetString(payload, "type"),
            DeviceId: GetString(payload, "deviceId"),
            BootId: GetString(payload, "bootId"),
            SessionId: GetString(payload, "sessionId"),
            SessionNonce: GetString(payload, "sessionNonce"));
    }

    private async Task WriteControlAsync(RuleRuntime runtime, string payload, CancellationToken cancellationToken)
    {
        if (runtime.ControlCharacteristic is null)
        {
            throw new InvalidOperationException("Control characteristic was unavailable.");
        }

        var bytes = Encoding.UTF8.GetBytes(payload);
        await runtime.ControlCharacteristic.WriteValueAsync(bytes, WriteOptions);
        await Task.Delay(60, cancellationToken);
    }

    private async Task HandleTelemetryEventAsync(RuleRuntime runtime, GattCharacteristicValueEventArgs eventArgs)
        => await HandleTelemetryPayloadAsync(runtime, eventArgs.Value, "notification", _shutdown.Token);

    private async Task HandleTelemetryPayloadAsync(
        RuleRuntime runtime,
        byte[] bytes,
        string source,
        CancellationToken cancellationToken)
    {
        if (ParseJson(bytes) is not JsonElement payload)
        {
            return;
        }

        var payloadText = JsonSerializer.Serialize(payload);
        if (string.Equals(payloadText, runtime.LastPayloadText, StringComparison.Ordinal))
        {
            return;
        }

        runtime.LastPayloadText = payloadText;

        var deviceId = GetString(payload, "deviceId") ?? runtime.Rule.KnownDeviceId;
        var state = GetString(payload, "state");
        var timestamp = GetInt64(payload, "timestamp");

        if (string.IsNullOrWhiteSpace(deviceId) || string.IsNullOrWhiteSpace(state) || timestamp is null)
        {
            Log("ignored telemetry payload missing required fields", new Dictionary<string, object?>
            {
                ["ruleId"] = runtime.Rule.Id,
                ["payload"] = payloadText,
            });
            return;
        }

        if (GetBool(payload, "snapshot") == true || string.Equals(runtime.LastMotionState, state, StringComparison.Ordinal))
        {
            var heartbeat = new Dictionary<string, object?>
            {
                ["deviceId"] = deviceId,
                ["timestamp"] = timestamp.Value,
            };
            CopyOptionalString(payload, heartbeat, "bootId");
            CopyOptionalString(payload, heartbeat, "firmwareVersion");
            CopyOptionalString(payload, heartbeat, "hardwareId");
            await PostAsync("/api/heartbeat", heartbeat, cancellationToken);
            Log("heartbeat forwarded", new Dictionary<string, object?>
            {
                ["ruleId"] = runtime.Rule.Id,
                ["source"] = source,
                ["deviceId"] = deviceId,
                ["state"] = state,
            });
            return;
        }

        var ingest = new Dictionary<string, object?>
        {
            ["deviceId"] = deviceId,
            ["state"] = state,
            ["timestamp"] = timestamp.Value,
            ["delta"] = GetInt64(payload, "delta"),
        };
        CopyOptionalString(payload, ingest, "sensorIssue");
        CopyOptionalInt64(payload, ingest, "sequence");
        CopyOptionalString(payload, ingest, "bootId");
        CopyOptionalString(payload, ingest, "firmwareVersion");
        CopyOptionalString(payload, ingest, "hardwareId");

        await PostAsync("/api/ingest", ingest, cancellationToken);
        runtime.LastMotionState = state;

        Log("motion forwarded", new Dictionary<string, object?>
        {
            ["ruleId"] = runtime.Rule.Id,
            ["source"] = source,
            ["deviceId"] = deviceId,
            ["state"] = state,
        });
    }

    private async Task PostAsync(string path, Dictionary<string, object?> payload, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsJsonAsync(
            $"{_config.BackendUrl}{path}",
            payload,
            cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    private static JsonElement? ParseJson(byte[] bytes)
    {
        var text = Encoding.UTF8.GetString(bytes).Trim('\0', ' ', '\r', '\n', '\t');
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var firstBrace = text.IndexOf('{');
        var lastBrace = text.LastIndexOf('}');
        if (firstBrace >= 0 && lastBrace >= firstBrace)
        {
            text = text[firstBrace..(lastBrace + 1)];
        }

        if (!text.StartsWith("{", StringComparison.Ordinal))
        {
            return null;
        }

        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    private static void CopyOptionalString(JsonElement payload, Dictionary<string, object?> target, string propertyName)
    {
        var value = GetString(payload, propertyName);
        if (!string.IsNullOrWhiteSpace(value))
        {
            target[propertyName] = value;
        }
    }

    private static void CopyOptionalInt64(JsonElement payload, Dictionary<string, object?> target, string propertyName)
    {
        var value = GetInt64(payload, propertyName);
        if (value is not null)
        {
            target[propertyName] = value.Value;
        }
    }

    private static string? GetString(JsonElement payload, string propertyName)
        => payload.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    private static long? GetInt64(JsonElement payload, string propertyName)
        => payload.TryGetProperty(propertyName, out var property) && property.TryGetInt64(out var value)
            ? value
            : null;

    private static bool? GetBool(JsonElement payload, string propertyName)
        => payload.TryGetProperty(propertyName, out var property) && property.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? property.GetBoolean()
            : null;

    private static Guid ReadGuid(string name, string fallback)
        => Guid.Parse(Environment.GetEnvironmentVariable(name) ?? fallback);

    private static string RandomHex(int characterCount)
    {
        var bytes = RandomNumberGenerator.GetBytes((characterCount + 1) / 2);
        var builder = new StringBuilder(bytes.Length * 2);
        foreach (var value in bytes)
        {
            builder.Append(value.ToString("x2"));
        }

        return builder.ToString()[..characterCount];
    }

    private static string? NormalizeAddress(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        var cleaned = new string(value.Where(char.IsAsciiHexDigit).ToArray()).ToUpperInvariant();
        return cleaned.Length == 12
            ? string.Join(":", Enumerable.Range(0, 6).Select(index => cleaned.Substring(index * 2, 2)))
            : value.ToUpperInvariant();
    }

    private static void Log(string message, Dictionary<string, object?>? details = null)
    {
        if (details is null)
        {
            Console.WriteLine($"[linux-gateway] {message}");
            return;
        }

        Console.WriteLine($"[linux-gateway] {message} {JsonSerializer.Serialize(details)}");
    }

    private async Task DisposeConnectionsAsync()
    {
        foreach (var runtime in _runtimeByRuleId.Values)
        {
            await runtime.DisposeClientAsync();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        _deviceWatcher?.Dispose();
        await DisposeConnectionsAsync();
        _httpClient.Dispose();
        _shutdown.Dispose();
    }
}

internal sealed class RuleRuntime
{
    private int _connecting;

    public RuleRuntime(ApprovedNodeRule rule)
    {
        Rule = rule;
    }

    public ApprovedNodeRule Rule { get; }
    public Device? Device { get; set; }
    public DeviceProperties? DeviceProperties { get; set; }
    public Device? Client { get; set; }
    public GattCharacteristic? TelemetryCharacteristic { get; set; }
    public GattCharacteristic? ControlCharacteristic { get; set; }
    public GattCharacteristic? StatusCharacteristic { get; set; }
    public string? SessionId { get; set; }
    public string? LastPayloadText { get; set; }
    public string? LastMotionState { get; set; }
    public CancellationTokenSource SessionCancellation { get; private set; } = new();
    public TaskCompletionSource DisconnectSignal { get; set; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public bool TryMarkConnecting()
        => Interlocked.CompareExchange(ref _connecting, 1, 0) == 0;

    public void MarkDisconnected()
        => Interlocked.Exchange(ref _connecting, 0);

    public void CancelSession()
    {
        SessionCancellation.Cancel();
        SessionCancellation.Dispose();
        SessionCancellation = new CancellationTokenSource();
    }

    public async Task DisposeClientAsync()
    {
        CancelSession();

        if (TelemetryCharacteristic is not null)
        {
            try
            {
                await TelemetryCharacteristic.StopNotifyAsync();
            }
            catch
            {
            }
        }

        if (Client is not null)
        {
            try
            {
                await Client.DisconnectAsync();
            }
            catch
            {
            }
        }

        Client = null;
        TelemetryCharacteristic = null;
        ControlCharacteristic = null;
        StatusCharacteristic = null;
        SessionId = null;
        LastPayloadText = null;
    }
}

internal sealed record ApprovedNodeRule(
    string Id,
    string Label,
    string? KnownDeviceId,
    string? LocalName,
    string? Address)
{
    public bool Matches(DeviceProperties device)
    {
        var normalizedAddress = NormalizeAddress(device.Address);
        var expectedAddress = NormalizeAddress(Address);

        if (!string.IsNullOrWhiteSpace(expectedAddress) &&
            string.Equals(expectedAddress, normalizedAddress, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(LocalName) || string.IsNullOrWhiteSpace(device.Name))
        {
            return false;
        }

        return string.Equals(LocalName, device.Name, StringComparison.Ordinal) ||
               device.Name.StartsWith(LocalName + "-s", StringComparison.Ordinal);
    }

    public static IReadOnlyList<ApprovedNodeRule> Load(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var nodes = document.RootElement.ValueKind == JsonValueKind.Array
            ? document.RootElement
            : document.RootElement.GetProperty("nodes");

        var rules = new List<ApprovedNodeRule>();
        var index = 0;
        foreach (var node in nodes.EnumerateArray())
        {
            index++;
            var label = GetString(node, "label") ?? $"Node {index}";
            var knownDeviceId = GetString(node, "knownDeviceId") ?? GetString(node, "known_device_id");
            var localName = GetString(node, "localName") ?? GetString(node, "local_name");
            var address = GetString(node, "address");

            if (knownDeviceId is null && localName is null && address is null)
            {
                throw new InvalidOperationException(
                    $"Approved node '{label}' must include at least one of knownDeviceId, localName, or address.");
            }

            rules.Add(new ApprovedNodeRule(
                Id: GetString(node, "id") ?? $"rule-{index}",
                Label: label,
                KnownDeviceId: knownDeviceId,
                LocalName: localName,
                Address: address));
        }

        return rules;
    }

    private static string? GetString(JsonElement payload, string propertyName)
        => payload.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    private static string? NormalizeAddress(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        var cleaned = new string(value.Where(char.IsAsciiHexDigit).ToArray()).ToUpperInvariant();
        return cleaned.Length == 12
            ? string.Join(":", Enumerable.Range(0, 6).Select(index => cleaned.Substring(index * 2, 2)))
            : value.ToUpperInvariant();
    }
}

internal sealed record SessionStatus(
    string? Type,
    string? DeviceId,
    string? BootId,
    string? SessionId,
    string? SessionNonce);

internal sealed class Config
{
    public required string BackendUrl { get; init; }
    public required string GatewayId { get; init; }
    public required string NodesFile { get; init; }
    public string? AdapterName { get; init; }

    private const string DefaultBackendUrl = "https://gym-motion-production.up.railway.app";

    public static Config Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);

        for (var index = 0; index < args.Length; index++)
        {
            var current = args[index];
            if (!current.StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException($"Unsupported argument '{current}'.");
            }

            if (index + 1 >= args.Length)
            {
                throw new ArgumentException($"Missing value for '{current}'.");
            }

            values[current[2..]] = args[++index];
        }

        var backendUrl =
            values.GetValueOrDefault("backend-url") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_CLOUD_API_BASE_URL") ??
            Environment.GetEnvironmentVariable("GATEWAY_BACKEND_URL") ??
            DefaultBackendUrl;
        var gatewayId =
            values.GetValueOrDefault("gateway-id") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_GATEWAY_ID") ??
            Environment.GetEnvironmentVariable("GATEWAY_ID");
        var nodesFile =
            values.GetValueOrDefault("nodes-file") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_GATEWAY_NODES_FILE") ??
            Environment.GetEnvironmentVariable("GATEWAY_NODES_FILE");
        var adapterName =
            values.GetValueOrDefault("adapter") ??
            Environment.GetEnvironmentVariable("GYM_MOTION_GATEWAY_ADAPTER") ??
            Environment.GetEnvironmentVariable("GATEWAY_ADAPTER") ??
            "hci0";

        if (string.IsNullOrWhiteSpace(gatewayId) || string.IsNullOrWhiteSpace(nodesFile))
        {
            throw new ArgumentException(
                "Usage: --gateway-id <id> --nodes-file <path> [--backend-url <url>] [--adapter <hci0>]. " +
                "You can also set GYM_MOTION_GATEWAY_ID, GYM_MOTION_GATEWAY_NODES_FILE, " +
                "GYM_MOTION_CLOUD_API_BASE_URL, and GYM_MOTION_GATEWAY_ADAPTER.");
        }

        return new Config
        {
            BackendUrl = backendUrl.TrimEnd('/'),
            GatewayId = gatewayId,
            NodesFile = nodesFile,
            AdapterName = adapterName,
        };
    }
}
