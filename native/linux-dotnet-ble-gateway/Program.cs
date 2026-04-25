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
            ["address"] = BleAddress.Normalize(properties.Address),
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
            ["address"] = BleAddress.Normalize(properties.Address),
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
            Type: GatewayJson.GetString(payload, "type"),
            DeviceId: GatewayJson.GetString(payload, "deviceId"),
            BootId: GatewayJson.GetString(payload, "bootId"),
            SessionId: GatewayJson.GetString(payload, "sessionId"),
            SessionNonce: GatewayJson.GetString(payload, "sessionNonce"));
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

        var deviceId = GatewayJson.GetString(payload, "deviceId") ?? runtime.Rule.KnownDeviceId;
        var state = GatewayJson.GetString(payload, "state");
        var timestamp = GatewayJson.GetInt64(payload, "timestamp");

        if (string.IsNullOrWhiteSpace(deviceId) || string.IsNullOrWhiteSpace(state) || timestamp is null)
        {
            Log("ignored telemetry payload missing required fields", new Dictionary<string, object?>
            {
                ["ruleId"] = runtime.Rule.Id,
                ["payload"] = payloadText,
            });
            return;
        }

        if (GatewayJson.GetBool(payload, "snapshot") == true || string.Equals(runtime.LastMotionState, state, StringComparison.Ordinal))
        {
            var heartbeat = new Dictionary<string, object?>
            {
                ["deviceId"] = deviceId,
                ["gatewayId"] = _config.GatewayId,
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
            ["gatewayId"] = _config.GatewayId,
            ["state"] = state,
            ["timestamp"] = timestamp.Value,
            ["delta"] = GatewayJson.GetInt64(payload, "delta"),
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
        var value = GatewayJson.GetString(payload, propertyName);
        if (!string.IsNullOrWhiteSpace(value))
        {
            target[propertyName] = value;
        }
    }

    private static void CopyOptionalInt64(JsonElement payload, Dictionary<string, object?> target, string propertyName)
    {
        var value = GatewayJson.GetInt64(payload, propertyName);
        if (value is not null)
        {
            target[propertyName] = value.Value;
        }
    }

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
