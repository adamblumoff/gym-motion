using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Radios;
using Windows.Security.Cryptography;
using Windows.Storage.Streams;

namespace GymMotion.WindowsBleSidecar;

internal static class Program
{
    public static async Task Main()
    {
        var app = new SidecarApp();
        await app.RunAsync();
    }
}

internal sealed class SidecarApp
{
    private const uint ProtocolVersion = 1;
    private static readonly TimeSpan ReconnectRetryDelay = TimeSpan.FromSeconds(1);
    private sealed record AdapterSnapshot(string Id, string Label, bool IsAvailable, string? Issue, string[] Details);

    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly SemaphoreSlim _stdoutLock = new(1, 1);
    private readonly Config _config = Config.FromEnvironment();
    private IReadOnlyDictionary<string, AllowedNodeRule> _allowedRulesById =
        new Dictionary<string, AllowedNodeRule>(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<ulong, DiscoveredNodeInfo> _discoveredNodes = new();
    private readonly ConcurrentDictionary<string, NodeConnection> _connectionsByRuleId = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly object _stateGate = new();

    private BluetoothLEAdvertisementWatcher? _watcher;
    private bool _sessionStarted;
    private DateTimeOffset? _lastAdvertisementAt;

    public async Task RunAsync()
    {
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            _shutdown.Cancel();
        };

        AppDomain.CurrentDomain.ProcessExit += (_, _) => _shutdown.Cancel();

        await EmitEventAsync(new
        {
            type = "ready",
            platform = "win32",
            protocol_version = ProtocolVersion,
        });

        await EmitAdapterListAsync();

        while (!_shutdown.IsCancellationRequested)
        {
            var line = await Console.In.ReadLineAsync();
            if (line is null)
            {
                break;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                using var document = JsonDocument.Parse(line);
                await HandleCommandAsync(document.RootElement);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception error)
            {
                await EmitErrorAsync("The .NET Windows BLE companion failed to process a command.", new
                {
                    error = error.Message,
                    line,
                });
            }
        }

        await StopAsync();
    }

    private async Task HandleCommandAsync(JsonElement root)
    {
        var type = GetString(root, "type");

        switch (type)
        {
            case "list_adapters":
                await EmitAdapterListAsync();
                break;
            case "set_allowed_nodes":
                await UpdateAllowedNodesAsync(root);
                if (_sessionStarted)
                {
                    TryConnectApprovedNodes();
                }
                break;
            case "start":
                await StartSessionAsync();
                break;
            case "rescan":
            case "refresh_scan_policy":
                await StartSessionAsync(forceRestart: true);
                break;
            case "stop":
                await StopAsync();
                break;
            case "shutdown":
                _shutdown.Cancel();
                break;
            default:
                await EmitLogAsync("warn", "Ignored unsupported .NET sidecar command.", new
                {
                    command = type,
                });
                break;
        }
    }

    private async Task StartSessionAsync(bool forceRestart = false)
    {
        _sessionStarted = true;
        EnsureWatcher(forceRestart);
        await EmitGatewayStateAsync();
        TryConnectApprovedNodes();
    }

    private async Task UpdateAllowedNodesAsync(JsonElement root)
    {
        var nextRulesById = ParseAllowedNodes(root);
        _allowedRulesById = nextRulesById;
        RemapDiscoveredNodes(nextRulesById);
        await DisposeStaleConnectionsAsync(nextRulesById);
    }

    private static Dictionary<string, AllowedNodeRule> ParseAllowedNodes(JsonElement root)
    {
        var rulesById = new Dictionary<string, AllowedNodeRule>(StringComparer.Ordinal);
        if (!root.TryGetProperty("nodes", out var nodesElement) || nodesElement.ValueKind != JsonValueKind.Array)
        {
            return rulesById;
        }

        foreach (var node in nodesElement.EnumerateArray())
        {
            var rule = new AllowedNodeRule(
                Id: GetString(node, "id") ?? $"rule-{Guid.NewGuid():N}",
                Label: GetString(node, "label") ?? "Approved node",
                PeripheralId: GetString(node, "peripheral_id"),
                Address: NormalizeAddress(GetString(node, "address")),
                LocalName: GetString(node, "local_name"),
                KnownDeviceId: GetString(node, "known_device_id"));

            rulesById[rule.Id] = rule;
        }

        return rulesById;
    }

    private void RemapDiscoveredNodes(IReadOnlyDictionary<string, AllowedNodeRule> rulesById)
    {
        var rules = rulesById.Values.ToArray();
        foreach (var entry in _discoveredNodes.ToArray())
        {
            var remapped = RemapDiscoveredNode(entry.Value, rules);
            if (remapped is null)
            {
                _discoveredNodes.TryRemove(entry.Key, out _);
                continue;
            }

            _discoveredNodes[entry.Key] = remapped;
        }
    }

    private static DiscoveredNodeInfo? RemapDiscoveredNode(
        DiscoveredNodeInfo discovered,
        IReadOnlyCollection<AllowedNodeRule> rules)
    {
        var matchedRule = MatchRule(rules, discovered.LocalName, discovered.Address);
        if (matchedRule is null)
        {
            return null;
        }

        return discovered with
        {
            Label = matchedRule.Label,
            KnownDeviceId = matchedRule.KnownDeviceId,
            MatchedRule = matchedRule,
        };
    }

    private async Task DisposeStaleConnectionsAsync(IReadOnlyDictionary<string, AllowedNodeRule> rulesById)
    {
        foreach (var entry in _connectionsByRuleId.ToArray())
        {
            if (rulesById.TryGetValue(entry.Key, out var nextRule) && Equals(entry.Value.Rule, nextRule))
            {
                continue;
            }

            if (!_connectionsByRuleId.TryRemove(entry.Key, out var connection))
            {
                continue;
            }

            await connection.DisposeAsync();
        }
    }

    private void EnsureWatcher(bool forceRestart = false)
    {
        if (forceRestart)
        {
            StopWatcher();
        }

        if (_watcher is not null)
        {
            return;
        }

        _watcher = new BluetoothLEAdvertisementWatcher
        {
            ScanningMode = BluetoothLEScanningMode.Active,
        };

        _watcher.Received += OnAdvertisementReceived;
        _watcher.Stopped += OnWatcherStopped;
        _watcher.Start();
    }

    private void StopWatcher()
    {
        var watcher = _watcher;
        _watcher = null;

        if (watcher is null)
        {
            return;
        }

        watcher.Received -= OnAdvertisementReceived;
        watcher.Stopped -= OnWatcherStopped;

        if (watcher.Status == BluetoothLEAdvertisementWatcherStatus.Started ||
            watcher.Status == BluetoothLEAdvertisementWatcherStatus.Created)
        {
            watcher.Stop();
        }
    }

    private async void OnAdvertisementReceived(BluetoothLEAdvertisementWatcher sender, BluetoothLEAdvertisementReceivedEventArgs args)
    {
        if (_shutdown.IsCancellationRequested)
        {
            return;
        }

        try
        {
            var info = BuildApprovedNode(args);
            if (info is null)
            {
                return;
            }

            _discoveredNodes[args.BluetoothAddress] = info;
            _lastAdvertisementAt = DateTimeOffset.UtcNow;

            await EmitNodeDiscoveredAsync(info);
            await EmitGatewayStateAsync();

            if (_sessionStarted)
            {
                _ = EnsureConnectedAsync(info);
            }
        }
        catch (Exception error)
        {
            await EmitLogAsync("error", "Failed to process advertisement.", new
            {
                error = error.Message,
            });
        }
    }

    private async void OnWatcherStopped(BluetoothLEAdvertisementWatcher sender, BluetoothLEAdvertisementWatcherStoppedEventArgs args)
    {
        if (_shutdown.IsCancellationRequested)
        {
            return;
        }

        await EmitLogAsync("warn", "Bluetooth advertisement watcher stopped.", new
        {
            error = args.Error.ToString(),
        });
    }

    private void TryConnectApprovedNodes()
    {
        foreach (var discovered in _discoveredNodes.Values.ToArray())
        {
            if (discovered.MatchedRule is null)
            {
                continue;
            }

            _ = EnsureConnectedAsync(discovered);
        }
    }

    private async Task EnsureConnectedAsync(DiscoveredNodeInfo discovered)
    {
        var rule = discovered.MatchedRule;
        if (rule is null)
        {
            return;
        }

        var connection = _connectionsByRuleId.GetOrAdd(rule.Id, _ => new NodeConnection(rule, this, _config));
        connection.UpdateDiscovered(discovered);
        await connection.ConnectIfNeededAsync(_shutdown.Token);
    }

    public async Task StopAsync()
    {
        StopWatcher();
        _sessionStarted = false;

        foreach (var connection in _connectionsByRuleId.Values)
        {
            await connection.DisposeAsync();
        }

        _connectionsByRuleId.Clear();
        await EmitGatewayStateAsync();
    }

    private async Task<AdapterSnapshot[]> ReadBluetoothAdaptersAsync()
    {
        var adapters = await Radio.GetRadiosAsync();
        return adapters
            .Where(radio => radio.Kind == RadioKind.Bluetooth)
            .Select((radio, index) => new AdapterSnapshot(
                $"winrt:{index}",
                string.IsNullOrWhiteSpace(radio.Name) ? "Bluetooth adapter" : radio.Name,
                radio.State == RadioState.On,
                radio.State switch
                {
                    RadioState.Disabled => "Adapter is disabled.",
                    RadioState.Off => "Adapter is powered off.",
                    _ => (string?)null,
                },
                new[]
                {
                    $"state:{radio.State}",
                    $"radio_index:{index}",
                }))
            .ToArray();
    }

    private async Task EmitAdapterListAsync()
    {
        var bluetoothRadios = await ReadBluetoothAdaptersAsync();

        await EmitEventAsync(new
        {
            type = "adapter_list",
            adapters = bluetoothRadios.Select(adapter => new
            {
                id = adapter.Id,
                label = adapter.Label,
                transport = "winrt",
                is_available = adapter.IsAvailable,
                issue = adapter.Issue,
                details = adapter.Details,
            }),
        });
    }

    private static string DeriveAdapterState(AdapterSnapshot[] adapters)
    {
        if (adapters.Any(adapter => adapter.IsAvailable))
        {
            return "poweredOn";
        }

        if (adapters.Any(adapter => !string.IsNullOrWhiteSpace(adapter.Issue)))
        {
            return "poweredOff";
        }

        return "unknown";
    }

    private async Task EmitGatewayStateAsync()
    {
        var adapterState = DeriveAdapterState(await ReadBluetoothAdaptersAsync());
        string scanState;
        lock (_stateGate)
        {
            scanState = _watcher?.Status == BluetoothLEAdvertisementWatcherStatus.Started
                ? "scanning"
                : "stopped";
        }

        await EmitEventAsync(new
        {
            type = "gateway_state",
            gateway = new
            {
                adapter_state = adapterState,
                scan_state = scanState,
                scan_reason = _sessionStarted ? "approved_nodes" : (string?)null,
                last_advertisement_at = _lastAdvertisementAt?.ToString("O"),
            },
        });
    }

    internal Task EmitNodeDiscoveredAsync(DiscoveredNodeInfo discovered)
        => EmitEventAsync(new
        {
            type = "node_discovered",
            node = discovered.ToProtocolNode(),
        });

    internal Task EmitNodeConnectionStateAsync(DiscoveredNodeInfo discovered, string state, string? bootId, string? reason = null)
        => EmitEventAsync(new
        {
            type = "node_connection_state",
            node = discovered.ToProtocolNode(),
            gateway_connection_state = state,
            boot_id = bootId,
            reason,
            reconnect = (object?)null,
        });

    internal Task EmitTelemetryAsync(DiscoveredNodeInfo discovered, string payloadText)
        => EmitEventAsync(new
        {
            type = "telemetry",
            node = discovered.ToProtocolNode(),
            payload_text = payloadText,
        });

    internal Task EmitLogAsync(string level, string message, object? details = null)
        => EmitEventAsync(new
        {
            type = "log",
            level,
            message,
            details,
        });

    internal Task EmitErrorAsync(string message, object? details = null)
        => EmitEventAsync(new
        {
            type = "error",
            message,
            details,
        });

    internal async Task EmitEventAsync(object payload)
    {
        var line = JsonSerializer.Serialize(payload, _jsonOptions);
        await _stdoutLock.WaitAsync();

        try
        {
            await Console.Out.WriteLineAsync(line);
            await Console.Out.FlushAsync();
        }
        finally
        {
            _stdoutLock.Release();
        }
    }

    private DiscoveredNodeInfo? BuildApprovedNode(BluetoothLEAdvertisementReceivedEventArgs args)
    {
        var localName = args.Advertisement.LocalName;
        var address = FormatBluetoothAddress(args.BluetoothAddress);
        var matchedRule = MatchRule(_allowedRulesById.Values, localName, address);

        if (matchedRule is null)
        {
            return null;
        }

        return new DiscoveredNodeInfo(
            BluetoothAddress: args.BluetoothAddress,
            NodeId: $"peripheral:{address}",
            Label: matchedRule.Label,
            PeripheralId: $"winrt:{address}",
            Address: address,
            LocalName: localName,
            KnownDeviceId: matchedRule.KnownDeviceId,
            LastRssi: args.RawSignalStrengthInDBm,
            LastSeenAt: DateTimeOffset.UtcNow,
            MatchedRule: matchedRule);
    }

    private static bool RuleMatches(AllowedNodeRule rule, string? localName, string address)
    {
        if (!string.IsNullOrWhiteSpace(rule.PeripheralId) &&
            string.Equals(rule.PeripheralId, $"winrt:{address}", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (!string.IsNullOrWhiteSpace(rule.Address) &&
            string.Equals(NormalizeAddress(rule.Address), NormalizeAddress(address), StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (!string.IsNullOrWhiteSpace(rule.LocalName) &&
            string.Equals(rule.LocalName, localName, StringComparison.Ordinal))
        {
            return true;
        }

        if (!string.IsNullOrWhiteSpace(rule.LocalName) &&
            !string.IsNullOrWhiteSpace(localName) &&
            localName.StartsWith(rule.LocalName + "-s", StringComparison.Ordinal))
        {
            return true;
        }

        return false;
    }

    private static AllowedNodeRule? MatchRule(
        IEnumerable<AllowedNodeRule> rules,
        string? localName,
        string address)
        => rules.FirstOrDefault(rule => RuleMatches(rule, localName, address));

    internal void ScheduleReconnect(DiscoveredNodeInfo discovered, string reason)
    {
        if (_shutdown.IsCancellationRequested)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(ReconnectRetryDelay, _shutdown.Token);

                if (_shutdown.IsCancellationRequested || !_sessionStarted)
                {
                    return;
                }

                var reconnectTarget = _discoveredNodes.TryGetValue(discovered.BluetoothAddress, out var current)
                    ? current
                    : discovered;

                if (reconnectTarget.MatchedRule is null)
                {
                    return;
                }

                await EmitLogAsync("info", "Retrying approved node connection after disconnect.", new
                {
                    node = reconnectTarget.NodeId,
                    reason,
                });
                await EnsureConnectedAsync(reconnectTarget);
            }
            catch (OperationCanceledException)
            {
            }
        }, _shutdown.Token);
    }

    private static string? GetString(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return property.GetString();
    }

    private static string FormatBluetoothAddress(ulong address)
    {
        var hex = address.ToString("X12");
        return string.Join(":", Enumerable.Range(0, 6).Select(index => hex.Substring(index * 2, 2)));
    }

    private static string? NormalizeAddress(string? address)
    {
        if (string.IsNullOrWhiteSpace(address))
        {
            return null;
        }

        var normalized = new string(address.Where(char.IsAsciiHexDigit).ToArray()).ToUpperInvariant();

        if (normalized.Length != 12)
        {
            return address.ToUpperInvariant();
        }

        return string.Join(":", Enumerable.Range(0, 6).Select(index => normalized.Substring(index * 2, 2)));
    }
}

internal sealed class NodeConnection
{
    private const int ControlChunkSize = 96;
    private static readonly TimeSpan ControlChunkInterval = TimeSpan.FromMilliseconds(60);

    private readonly AllowedNodeRule _rule;
    private readonly SidecarApp _app;
    private readonly Config _config;
    private readonly SemaphoreSlim _connectGate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();

    private DiscoveredNodeInfo? _discovered;
    private BluetoothLEDevice? _device;
    private GattDeviceService? _runtimeService;
    private GattCharacteristic? _telemetryCharacteristic;
    private GattCharacteristic? _controlCharacteristic;
    private GattCharacteristic? _statusCharacteristic;
    private CancellationTokenSource? _sessionLifetime;
    private Task? _leaseLoop;
    private string? _lastTelemetryPayload;
    private string? _activeSessionId;
    private bool _disposed;

    public NodeConnection(AllowedNodeRule rule, SidecarApp app, Config config)
    {
        _rule = rule;
        _app = app;
        _config = config;
    }

    public string? DeviceId { get; private set; }
    public AllowedNodeRule Rule => _rule;

    public void UpdateDiscovered(DiscoveredNodeInfo discovered)
    {
        _discovered = discovered;
    }

    public async Task ConnectIfNeededAsync(CancellationToken shutdownToken)
    {
        if (_discovered is null)
        {
            return;
        }

        using var connectAttempt = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken, _lifetime.Token);
        var connectToken = connectAttempt.Token;
        var gateHeld = false;

        try
        {
            await _connectGate.WaitAsync(connectToken);
            gateHeld = true;

            if (_disposed || connectToken.IsCancellationRequested)
            {
                return;
            }

            if (_device is not null &&
                _device.ConnectionStatus == BluetoothConnectionStatus.Connected &&
                _sessionLifetime is not null &&
                !_sessionLifetime.IsCancellationRequested)
            {
                return;
            }

            var discovered = _discovered;
            await _app.EmitNodeConnectionStateAsync(discovered, "connecting", bootId: null);

            await ConnectGattAsync(discovered, connectToken);

            var existingStatus = await ReadSessionStatusAsync(connectToken);
            if (existingStatus is not null &&
                string.Equals(existingStatus.Type, "app-session-online", StringComparison.Ordinal) &&
                !string.IsNullOrWhiteSpace(existingStatus.SessionId))
            {
                DeviceId = existingStatus.DeviceId ?? _rule.KnownDeviceId ?? discovered.NodeId;

                var adoptedBootId = existingStatus.BootId;
                var adoptedSessionId = existingStatus.SessionId;
                await _app.EmitLogAsync("info", "Adopted active session from direct runtime-status read.", new
                {
                    node = discovered.NodeId,
                    sessionId = adoptedSessionId,
                    bootId = adoptedBootId,
                });

            _activeSessionId = adoptedSessionId;
            await _app.EmitNodeConnectionStateAsync(discovered, "connected", adoptedBootId);
            await EmitBootstrapTelemetryAsync(discovered, connectToken);
            StartLeaseLoop(discovered, adoptedSessionId, connectToken);
            return;
        }

            var sessionId = RandomHexToken(8);
            var sessionNonce = RandomHexToken(8);
            var beginPayload = JsonSerializer.Serialize(new
            {
                type = "app-session-begin",
                sessionId,
                sessionNonce,
                expiresInMs = 15000,
            });

            if (!await WriteControlAsync(beginPayload, connectToken))
            {
                throw new InvalidOperationException("Session begin write failed.");
            }

            var status = await WaitForSessionStatusAsync(sessionId, sessionNonce, connectToken);
            if (status is null)
            {
                throw new InvalidOperationException("Session status verification failed.");
            }

            DeviceId = status.DeviceId ?? _rule.KnownDeviceId ?? discovered.NodeId;

            var bootId = status.BootId;
            await _app.EmitLogAsync("info", "Established session via direct runtime-status verification.", new
            {
                node = discovered.NodeId,
                sessionId,
                sessionNonce,
                bootId,
            });

            _activeSessionId = sessionId;
            await _app.EmitNodeConnectionStateAsync(discovered, "connected", bootId);
            await EmitBootstrapTelemetryAsync(discovered, connectToken);
            StartLeaseLoop(discovered, sessionId, connectToken);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            var discovered = _discovered;
            if (discovered is not null)
            {
                await _app.EmitLogAsync("error", "Failed to connect approved node via .NET WinRT companion.", new
                {
                    ruleId = _rule.Id,
                    node = discovered.NodeId,
                    error = error.Message,
                });
                await _app.EmitNodeConnectionStateAsync(discovered, "disconnected", bootId: null, reason: error.Message);
                _app.ScheduleReconnect(discovered, "connect_failed");
            }

            ResetConnectionState();
        }
        finally
        {
            if (gateHeld)
            {
                _connectGate.Release();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        var gateHeld = false;

        try
        {
            await _connectGate.WaitAsync();
            gateHeld = true;

            await TryEndSessionAsync();

            _lifetime.Cancel();
            _sessionLifetime?.Cancel();

            var leaseLoop = _leaseLoop;
            if (leaseLoop is not null)
            {
                try
                {
                    await leaseLoop;
                }
                catch
                {
                }
            }

            ResetConnectionState();
        }
        finally
        {
            if (gateHeld)
            {
                _connectGate.Release();
            }

            _connectGate.Dispose();
            _lifetime.Dispose();
        }
    }

    private async Task ConnectGattAsync(DiscoveredNodeInfo discovered, CancellationToken shutdownToken)
    {
        ResetConnectionState();

        _device = await WithTimeout(
            BluetoothLEDevice.FromBluetoothAddressAsync(discovered.BluetoothAddress).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (_device is null)
        {
            throw new InvalidOperationException("Device connection failed.");
        }

        _device.ConnectionStatusChanged += OnConnectionStatusChanged;

        _runtimeService = await GetRequiredServiceAsync(_device, _config.RuntimeServiceUuid, shutdownToken);

        _telemetryCharacteristic = await GetRequiredCharacteristicAsync(_runtimeService, _config.TelemetryUuid, shutdownToken);
        _controlCharacteristic = await GetRequiredCharacteristicAsync(_runtimeService, _config.ControlUuid, shutdownToken);
        _statusCharacteristic = await GetRequiredCharacteristicAsync(_runtimeService, _config.StatusUuid, shutdownToken);
        await EnableTelemetryNotificationsAsync(discovered, shutdownToken);
    }

    private async Task<SessionStatus?> WaitForSessionStatusAsync(
        string expectedSessionId,
        string expectedSessionNonce,
        CancellationToken shutdownToken)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(12);

        while (DateTimeOffset.UtcNow < deadline && !shutdownToken.IsCancellationRequested)
        {
            var status = await ReadSessionStatusAsync(shutdownToken);
            if (status is not null &&
                string.Equals(status.Type, "app-session-online", StringComparison.Ordinal) &&
                string.Equals(status.SessionId, expectedSessionId, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(status.SessionNonce, expectedSessionNonce, StringComparison.OrdinalIgnoreCase))
            {
                return status;
            }

            await Task.Delay(250, shutdownToken);
        }

        return null;
    }

    private void StartLeaseLoop(DiscoveredNodeInfo discovered, string sessionId, CancellationToken shutdownToken)
    {
        _sessionLifetime?.Cancel();
        _sessionLifetime?.Dispose();
        _sessionLifetime = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token, shutdownToken);
        var leaseToken = _sessionLifetime.Token;

        _leaseLoop = Task.Run(async () =>
        {
            while (!leaseToken.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(5), leaseToken);

                var wrote = await WriteControlAsync(JsonSerializer.Serialize(new
                {
                    type = "app-session-lease",
                    sessionId,
                    expiresInMs = 15000,
                }), leaseToken);

                if (!wrote)
                {
                    await _app.EmitNodeConnectionStateAsync(discovered, "disconnected", bootId: null, reason: "Session lease write failed.");
                    ResetConnectionState();
                    _app.ScheduleReconnect(discovered, "lease_write_failed");
                    return;
                }
            }
        }, leaseToken);
    }

    private async void OnConnectionStatusChanged(BluetoothLEDevice sender, object args)
    {
        if (_disposed || _lifetime.IsCancellationRequested)
        {
            return;
        }

        if (sender.ConnectionStatus == BluetoothConnectionStatus.Connected)
        {
            return;
        }

        var discovered = _discovered;
        ResetConnectionState();

        if (discovered is not null)
        {
            await _app.EmitNodeConnectionStateAsync(discovered, "disconnected", bootId: null, reason: "Bluetooth connection dropped.");
            _app.ScheduleReconnect(discovered, "connection_dropped");
        }
    }

    private async Task EnableTelemetryNotificationsAsync(
        DiscoveredNodeInfo discovered,
        CancellationToken shutdownToken)
    {
        if (_telemetryCharacteristic is null)
        {
            return;
        }

        _telemetryCharacteristic.ValueChanged -= OnTelemetryValueChanged;
        var result = await WithTimeout(
            _telemetryCharacteristic.WriteClientCharacteristicConfigurationDescriptorWithResultAsync(
                GattClientCharacteristicConfigurationDescriptorValue.Notify).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        await _app.EmitLogAsync("info", "Configured telemetry notifications.", new
        {
            node = discovered.NodeId,
            status = result.Status.ToString(),
        });

        if (result.Status == GattCommunicationStatus.Success)
        {
            _telemetryCharacteristic.ValueChanged += OnTelemetryValueChanged;
        }
    }

    private async void OnTelemetryValueChanged(
        GattCharacteristic sender,
        GattValueChangedEventArgs args)
    {
        if (_disposed || _lifetime.IsCancellationRequested)
        {
            return;
        }

        var discovered = _discovered;
        if (discovered is null)
        {
            return;
        }

        try
        {
            var payload = ReadBufferText(args.CharacteristicValue);
            await EmitTelemetryPayloadAsync(discovered, payload, "notification");
        }
        catch (Exception error)
        {
            await _app.EmitLogAsync("error", "Telemetry notification handler failed.", new
            {
                node = discovered.NodeId,
                error = error.Message,
            });
        }
    }

    private async Task EmitBootstrapTelemetryAsync(
        DiscoveredNodeInfo discovered,
        CancellationToken shutdownToken)
    {
        try
        {
            var payload = await ReadCurrentTelemetryPayloadAsync(shutdownToken);
            await EmitTelemetryPayloadAsync(discovered, payload, "bootstrap-read");
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            await _app.EmitLogAsync("warn", "Bootstrap telemetry read failed.", new
            {
                node = discovered.NodeId,
                error = error.Message,
            });
        }
    }

    private async Task EmitTelemetryPayloadAsync(
        DiscoveredNodeInfo discovered,
        string? payload,
        string source)
    {
        if (string.IsNullOrWhiteSpace(payload))
        {
            return;
        }

        if (string.Equals(payload, _lastTelemetryPayload, StringComparison.Ordinal))
        {
            return;
        }

        _lastTelemetryPayload = payload;
        await _app.EmitLogAsync("info", "Telemetry produced a fresh payload.", new
        {
            node = discovered.NodeId,
            source,
            payload,
        });
        await _app.EmitTelemetryAsync(discovered, payload);
    }

    private async Task TryEndSessionAsync()
    {
        if (_controlCharacteristic is null || string.IsNullOrWhiteSpace(_activeSessionId))
        {
            return;
        }

        try
        {
            await WriteControlAsync(JsonSerializer.Serialize(new
            {
                type = "app-session-end",
                sessionId = _activeSessionId,
            }), _lifetime.Token);

            await Task.Delay(TimeSpan.FromMilliseconds(300));
        }
        catch
        {
        }
    }

    private async Task<SessionStatus?> ReadSessionStatusAsync(CancellationToken shutdownToken)
    {
        if (_statusCharacteristic is null)
        {
            return null;
        }

        var result = await WithTimeout(
            _statusCharacteristic.ReadValueAsync(BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status != GattCommunicationStatus.Success)
        {
            return null;
        }

        var text = ReadBufferText(result.Value);
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            return new SessionStatus(
                Type: GetString(root, "type"),
                DeviceId: GetString(root, "deviceId"),
                BootId: GetString(root, "bootId"),
                SessionId: GetString(root, "sessionId"),
                SessionNonce: GetString(root, "sessionNonce"));
        }
        catch
        {
            return null;
        }
    }

    private async Task<string?> ReadStatusTextAsync(CancellationToken shutdownToken)
    {
        if (_statusCharacteristic is null)
        {
            return null;
        }

        var result = await WithTimeout(
            _statusCharacteristic.ReadValueAsync(BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status != GattCommunicationStatus.Success)
        {
            return null;
        }

        var text = ReadBufferText(result.Value);
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    private async Task<string?> ReadCurrentTelemetryPayloadAsync(CancellationToken shutdownToken)
    {
        if (_telemetryCharacteristic is null)
        {
            return null;
        }

        var result = await WithTimeout(
            _telemetryCharacteristic.ReadValueAsync(BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status != GattCommunicationStatus.Success)
        {
            return null;
        }

        var text = ReadBufferText(result.Value);
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        return text.StartsWith("{", StringComparison.Ordinal) ? text : null;
    }

    private async Task<GattDeviceService> GetRequiredServiceAsync(
        BluetoothLEDevice device,
        Guid uuid,
        CancellationToken shutdownToken)
    {
        var result = await WithTimeout(
            device.GetGattServicesForUuidAsync(uuid, BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status == GattCommunicationStatus.Success && result.Services.Count > 0)
        {
            return result.Services[0];
        }

        throw new InvalidOperationException($"Required GATT service {uuid} was not available.");
    }

    private async Task<GattCharacteristic> GetRequiredCharacteristicAsync(
        GattDeviceService service,
        Guid uuid,
        CancellationToken shutdownToken)
    {
        var result = await WithTimeout(
            service.GetCharacteristicsForUuidAsync(uuid, BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status == GattCommunicationStatus.Success && result.Characteristics.Count > 0)
        {
            return result.Characteristics[0];
        }

        throw new InvalidOperationException($"Required GATT characteristic {uuid} was not available.");
    }

    private async Task<bool> WriteControlAsync(string payload, CancellationToken shutdownToken)
    {
        if (_controlCharacteristic is null)
        {
            return false;
        }

        var frames = BuildControlFrames(payload);

        foreach (var frame in frames)
        {
            var buffer = CryptographicBuffer.CreateFromByteArray(frame);
            var result = await WithTimeout(
                _controlCharacteristic.WriteValueWithResultAsync(buffer, GattWriteOption.WriteWithResponse).AsTask(),
                TimeSpan.FromSeconds(8),
                shutdownToken);

            if (result.Status != GattCommunicationStatus.Success)
            {
                return false;
            }

            await Task.Delay(ControlChunkInterval, shutdownToken);
        }

        return true;
    }

    private void ResetConnectionState()
    {
        _sessionLifetime?.Cancel();
        _sessionLifetime?.Dispose();
        _sessionLifetime = null;
        _leaseLoop = null;
        _lastTelemetryPayload = null;
        _activeSessionId = null;

        if (_device is not null)
        {
            _device.ConnectionStatusChanged -= OnConnectionStatusChanged;
        }

        if (_telemetryCharacteristic is not null)
        {
            _telemetryCharacteristic.ValueChanged -= OnTelemetryValueChanged;
        }

        _telemetryCharacteristic = null;
        _statusCharacteristic = null;
        _controlCharacteristic = null;
        _runtimeService?.Dispose();
        _runtimeService = null;
        _device?.Dispose();
        _device = null;
        DeviceId = null;
    }

    private static string ReadBufferText(IBuffer buffer)
    {
        var bytes = ReadBufferBytes(buffer);
        var text = Encoding.UTF8.GetString(bytes).Trim('\0', ' ', '\r', '\n', '\t');

        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var firstBrace = text.IndexOf('{');
        var lastBrace = text.LastIndexOf('}');

        if (firstBrace >= 0 && lastBrace >= firstBrace)
        {
            text = text[firstBrace..(lastBrace + 1)];
        }

        return text;
    }

    private static byte[] ReadBufferBytes(IBuffer buffer)
    {
        CryptographicBuffer.CopyToByteArray(buffer, out byte[] bytes);
        return bytes;
    }

    private static string RandomHexToken(int characterCount)
    {
        var bytes = RandomNumberGenerator.GetBytes((characterCount + 1) / 2);
        var builder = new StringBuilder(bytes.Length * 2);

        foreach (var value in bytes)
        {
            builder.Append(value.ToString("x2"));
        }

        return builder.ToString()[..characterCount];
    }

    private static IReadOnlyList<byte[]> BuildControlFrames(string payload)
    {
        var bytes = Encoding.UTF8.GetBytes(payload);
        var frames = new List<byte[]>
        {
            Encoding.UTF8.GetBytes($"BEGIN:{bytes.Length}"),
        };

        for (var offset = 0; offset < bytes.Length; offset += ControlChunkSize)
        {
            var count = Math.Min(ControlChunkSize, bytes.Length - offset);
            var chunk = new byte[count];
            Array.Copy(bytes, offset, chunk, 0, count);
            frames.Add(chunk);
        }

        frames.Add(Encoding.UTF8.GetBytes("END"));
        return frames;
    }

    private static async Task<T> WithTimeout<T>(Task<T> task, TimeSpan timeout, CancellationToken shutdownToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
        var delay = Task.Delay(timeout, timeoutCts.Token);
        var completed = await Task.WhenAny(task, delay);

        if (completed == delay)
        {
            throw new TimeoutException("WinRT BLE operation timed out.");
        }

        timeoutCts.Cancel();
        return await task;
    }

    private static string? GetString(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return property.GetString();
    }
}

internal sealed record AllowedNodeRule(
    string Id,
    string Label,
    string? PeripheralId,
    string? Address,
    string? LocalName,
    string? KnownDeviceId);

internal sealed record DiscoveredNodeInfo(
    ulong BluetoothAddress,
    string NodeId,
    string Label,
    string PeripheralId,
    string Address,
    string? LocalName,
    string? KnownDeviceId,
    short LastRssi,
    DateTimeOffset LastSeenAt,
    AllowedNodeRule? MatchedRule)
{
    public object ToProtocolNode() => new
    {
        id = NodeId,
        label = Label,
        peripheral_id = PeripheralId,
        address = Address,
        local_name = LocalName,
        known_device_id = KnownDeviceId,
        last_rssi = (int)LastRssi,
        last_seen_at = LastSeenAt.ToString("O"),
    };
}

internal sealed record SessionStatus(
    string? Type,
    string? DeviceId,
    string? BootId,
    string? SessionId,
    string? SessionNonce);

internal sealed record Config(
    Guid RuntimeServiceUuid,
    Guid TelemetryUuid,
    Guid ControlUuid,
    Guid StatusUuid)
{
    public static Config FromEnvironment() => new(
        RuntimeServiceUuid: ReadGuid("BLE_RUNTIME_SERVICE_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001"),
        TelemetryUuid: ReadGuid("BLE_TELEMETRY_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002"),
        ControlUuid: ReadGuid("BLE_CONTROL_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003"),
        StatusUuid: ReadGuid("BLE_STATUS_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7004"));

    private static Guid ReadGuid(string name, string fallback)
        => Guid.Parse(Environment.GetEnvironmentVariable(name) ?? fallback);
}
