using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Radios;
using Windows.Foundation;
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

    private readonly JsonSerializerOptions _jsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly SemaphoreSlim _stdoutLock = new(1, 1);
    private readonly Config _config = Config.FromEnvironment();
    private readonly Dictionary<string, AllowedNodeRule> _allowedRulesById = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<ulong, DiscoveredNodeInfo> _discoveredNodes = new();
    private readonly ConcurrentDictionary<string, NodeConnection> _connectionsByRuleId = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly object _stateGate = new();

    private BluetoothLEAdvertisementWatcher? _watcher;
    private bool _sessionStarted;
    private bool _manualScanRequested;
    private string? _selectedAdapterId;
    private DateTimeOffset? _lastAdvertisementAt;
    private string? _gatewayIssue;

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
            case "select_adapter":
                _selectedAdapterId = GetString(root, "adapter_id");
                await EmitGatewayStateAsync();
                break;
            case "set_allowed_nodes":
                UpdateAllowedNodes(root);
                break;
            case "start":
                _sessionStarted = true;
                _manualScanRequested = false;
                EnsureWatcher();
                await EmitGatewayStateAsync();
                await TryConnectApprovedNodesAsync();
                break;
            case "rescan":
                _manualScanRequested = false;
                EnsureWatcher(forceRestart: true);
                await EmitGatewayStateAsync();
                break;
            case "start_manual_scan":
                _manualScanRequested = true;
                EnsureWatcher(forceRestart: true);
                await EmitEventAsync(new
                {
                    type = "manual_scan_state",
                    state = "scanning",
                    candidate_id = (string?)null,
                    error = (string?)null,
                });
                await EmitGatewayStateAsync();
                break;
            case "refresh_scan_policy":
                await TryConnectApprovedNodesAsync();
                break;
            case "begin_history_sync":
                await BeginHistorySyncAsync(root);
                break;
            case "acknowledge_history_sync":
                await AcknowledgeHistorySyncAsync(root);
                break;
            case "pair_manual_candidate":
                await PairManualCandidateAsync(root);
                break;
            case "recover_approved_node":
            case "resume_approved_node_reconnect":
                await TryConnectApprovedNodesAsync();
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

    private void UpdateAllowedNodes(JsonElement root)
    {
        _allowedRulesById.Clear();

        if (root.TryGetProperty("nodes", out var nodesElement) && nodesElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var node in nodesElement.EnumerateArray())
            {
                var rule = new AllowedNodeRule(
                    Id: GetString(node, "id") ?? $"rule-{Guid.NewGuid():N}",
                    Label: GetString(node, "label") ?? "Approved node",
                    PeripheralId: GetString(node, "peripheral_id"),
                    Address: NormalizeAddress(GetString(node, "address")),
                    LocalName: GetString(node, "local_name"),
                    KnownDeviceId: GetString(node, "known_device_id"));

                _allowedRulesById[rule.Id] = rule;
            }
        }
    }

    private async Task BeginHistorySyncAsync(JsonElement root)
    {
        var deviceId = GetString(root, "device_id");
        var requestId = GetString(root, "request_id");

        if (deviceId is null || requestId is null)
        {
            return;
        }

        var connection = FindConnectionByDeviceId(deviceId);

        if (connection is null)
        {
            await EmitHistoryErrorAsync(deviceId, requestId, "history_connection_missing", "Node is not connected.");
            return;
        }

        var payload = JsonSerializer.Serialize(new
        {
            type = "history-page-request",
            sessionId = connection.SessionId,
            requestId,
            afterSequence = GetUInt64(root, "after_sequence") ?? 0,
            maxRecords = GetInt32(root, "max_records") ?? 0,
        }, _jsonOptions);

        var wrote = await connection.WriteHistoryControlAsync(payload, _shutdown.Token);

        if (!wrote)
        {
            await EmitHistoryErrorAsync(deviceId, requestId, "history_write_failed", "History request write failed.");
        }
    }

    private async Task AcknowledgeHistorySyncAsync(JsonElement root)
    {
        var deviceId = GetString(root, "device_id");
        var requestId = GetString(root, "request_id");

        if (deviceId is null || requestId is null)
        {
            return;
        }

        var connection = FindConnectionByDeviceId(deviceId);

        if (connection is null)
        {
            await EmitHistoryErrorAsync(deviceId, requestId, "history_connection_missing", "Node is not connected.");
            return;
        }

        var payload = JsonSerializer.Serialize(new
        {
            type = "history-page-ack",
            sessionId = connection.SessionId,
            requestId,
            sequence = GetUInt64(root, "sequence") ?? 0,
        }, _jsonOptions);

        var wrote = await connection.WriteHistoryControlAsync(payload, _shutdown.Token);

        if (!wrote)
        {
            await EmitHistoryErrorAsync(deviceId, requestId, "history_ack_failed", "History ack write failed.");
        }
    }

    private async Task PairManualCandidateAsync(JsonElement root)
    {
        var candidateId = GetString(root, "candidate_id");

        if (candidateId is null)
        {
            return;
        }

        var candidate = _discoveredNodes.Values.FirstOrDefault(node => node.NodeId == candidateId);

        if (candidate is null)
        {
            await EmitEventAsync(new
            {
                type = "manual_scan_state",
                state = "failed",
                candidate_id = (string?)null,
                error = "The requested pairing candidate is no longer visible.",
            });
            return;
        }

        await EmitEventAsync(new
        {
            type = "manual_scan_state",
            state = "pairing",
            candidate_id = candidate.NodeId,
            error = (string?)null,
        });

        await EmitNodeDiscoveredAsync(candidate, "manual_scan");

        await EmitEventAsync(new
        {
            type = "manual_scan_state",
            state = "idle",
            candidate_id = (string?)null,
            error = (string?)null,
        });
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
            var info = BuildDiscoveredNode(args);

            if (info is null)
            {
                return;
            }

            _discoveredNodes[args.BluetoothAddress] = info;
            _lastAdvertisementAt = DateTimeOffset.UtcNow;

            if (_manualScanRequested || info.MatchedRule is not null)
            {
                await EmitNodeDiscoveredAsync(info, _manualScanRequested && info.MatchedRule is null ? "manual_scan" : null);
            }

            await EmitGatewayStateAsync();

            if (_sessionStarted && info.MatchedRule is not null)
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

    private async Task TryConnectApprovedNodesAsync()
    {
        foreach (var node in _discoveredNodes.Values.Where(candidate => candidate.MatchedRule is not null))
        {
            _ = EnsureConnectedAsync(node);
        }
    }

    private async Task EnsureConnectedAsync(DiscoveredNodeInfo discovered)
    {
        var rule = discovered.MatchedRule;

        if (rule is null)
        {
            return;
        }

        var connection = _connectionsByRuleId.GetOrAdd(rule.Id, _ => new NodeConnection(discovered, rule, this, _config));
        await connection.ConnectIfNeededAsync(_shutdown.Token);
    }

    public async Task StopAsync()
    {
        StopWatcher();
        _sessionStarted = false;
        _manualScanRequested = false;

        foreach (var connection in _connectionsByRuleId.Values)
        {
            await connection.DisposeAsync();
        }

        _connectionsByRuleId.Clear();
        await EmitGatewayStateAsync();
    }

    private async Task EmitAdapterListAsync()
    {
        var adapters = await Radio.GetRadiosAsync();
        var bluetoothRadios = adapters
            .Where(radio => radio.Kind == RadioKind.Bluetooth)
            .Select((radio, index) => new
            {
                id = $"winrt:{index}",
                label = string.IsNullOrWhiteSpace(radio.Name) ? "Bluetooth adapter" : radio.Name,
                transport = "winrt",
                is_available = radio.State == RadioState.On,
                issue = radio.State switch
                {
                    RadioState.Disabled => "Adapter is disabled.",
                    RadioState.Off => "Adapter is powered off.",
                    _ => (string?)null,
                },
                details = new[]
                {
                    $"state:{radio.State}",
                    $"radio_index:{index}",
                },
            })
            .ToArray();

        await EmitEventAsync(new
        {
            type = "adapter_list",
            adapters = bluetoothRadios,
        });
    }

    private async Task EmitGatewayStateAsync()
    {
        string scanState;
        lock (_stateGate)
        {
            scanState = _watcher?.Status == BluetoothLEAdvertisementWatcherStatus.Started
                ? (_manualScanRequested ? "manual_scanning" : "scanning")
                : "stopped";
        }

        await EmitEventAsync(new
        {
            type = "gateway_state",
            gateway = new
            {
                adapter_state = string.IsNullOrWhiteSpace(_selectedAdapterId) ? "unknown" : "ready",
                scan_state = scanState,
                scan_reason = _manualScanRequested ? "manual" : (_sessionStarted ? "approved_nodes" : (string?)null),
                selected_adapter_id = _selectedAdapterId,
                last_advertisement_at = _lastAdvertisementAt?.ToString("O"),
                issue = _gatewayIssue,
            },
        });
    }

    internal async Task EmitNodeDiscoveredAsync(DiscoveredNodeInfo discovered, string? scanReason)
    {
        await EmitEventAsync(new
        {
            type = "node_discovered",
            node = discovered.ToProtocolNode(),
            scan_reason = scanReason,
        });
    }

    internal async Task EmitNodeConnectionStateAsync(DiscoveredNodeInfo discovered, string state, string? bootId, string? reason = null)
    {
        await EmitEventAsync(new
        {
            type = "node_connection_state",
            node = discovered.ToProtocolNode(),
            gateway_connection_state = state,
            boot_id = bootId,
            reason,
            reconnect = (object?)null,
        });
    }

    internal async Task EmitTelemetryAsync(DiscoveredNodeInfo discovered, JsonObject payload)
    {
        await EmitEventAsync(new
        {
            type = "telemetry",
            node = discovered.ToProtocolNode(),
            payload,
        });
    }

    internal async Task EmitHistoryRecordAsync(DiscoveredNodeInfo discovered, string deviceId, string requestId, JsonNode record)
    {
        await EmitEventAsync(new
        {
            type = "history_record",
            node = discovered.ToProtocolNode(),
            device_id = deviceId,
            request_id = requestId,
            record,
        });
    }

    internal async Task EmitHistorySyncCompleteAsync(DiscoveredNodeInfo discovered, JsonObject payload)
    {
        await EmitEventAsync(new
        {
            type = "history_sync_complete",
            node = discovered.ToProtocolNode(),
            payload,
        });
    }

    internal async Task EmitHistoryErrorAsync(string deviceId, string? requestId, string code, string message)
    {
        await EmitEventAsync(new
        {
            type = "history_error",
            node = new
            {
                id = deviceId,
                label = deviceId,
                peripheral_id = (string?)null,
                address = (string?)null,
                local_name = (string?)null,
                known_device_id = deviceId,
                last_rssi = (int?)null,
                last_seen_at = (string?)null,
            },
            payload = new
            {
                type = "history-error",
                device_id = deviceId,
                session_id = (string?)null,
                request_id = requestId,
                code,
                message,
            },
        });
    }

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

    private DiscoveredNodeInfo? BuildDiscoveredNode(BluetoothLEAdvertisementReceivedEventArgs args)
    {
        var localName = args.Advertisement.LocalName;
        var address = FormatBluetoothAddress(args.BluetoothAddress);
        var matchedRule = _allowedRulesById.Values.FirstOrDefault(rule => RuleMatches(rule, localName, address));

        if (!_manualScanRequested && matchedRule is null)
        {
            return null;
        }

        if (_manualScanRequested && matchedRule is null &&
            !string.IsNullOrEmpty(_config.DeviceNamePrefix) &&
            !(localName?.StartsWith(_config.DeviceNamePrefix, StringComparison.OrdinalIgnoreCase) ?? false))
        {
            return null;
        }

        return new DiscoveredNodeInfo(
            BluetoothAddress: args.BluetoothAddress,
            NodeId: $"peripheral:{address}",
            Label: matchedRule?.Label ?? localName ?? address,
            PeripheralId: $"winrt:{address}",
            Address: address,
            LocalName: localName,
            KnownDeviceId: matchedRule?.KnownDeviceId,
            LastRssi: args.RawSignalStrengthInDBm,
            LastSeenAt: DateTimeOffset.UtcNow,
            MatchedRule: matchedRule);
    }

    private static bool RuleMatches(AllowedNodeRule rule, string? localName, string address)
    {
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

        return false;
    }

    private NodeConnection? FindConnectionByDeviceId(string deviceId)
    {
        return _connectionsByRuleId.Values.FirstOrDefault(connection =>
            string.Equals(connection.DeviceId, deviceId, StringComparison.Ordinal));
    }

    private static string? GetString(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return property.GetString();
    }

    private static int? GetInt32(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.Number)
        {
            return null;
        }

        return property.GetInt32();
    }

    private static ulong? GetUInt64(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.Number)
        {
            return null;
        }

        return property.GetUInt64();
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

    private readonly DiscoveredNodeInfo _discovered;
    private readonly AllowedNodeRule _rule;
    private readonly SidecarApp _app;
    private readonly Config _config;
    private readonly SemaphoreSlim _connectGate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();

    private BluetoothLEDevice? _device;
    private GattDeviceService? _runtimeService;
    private GattDeviceService? _historyService;
    private GattCharacteristic? _telemetryCharacteristic;
    private GattCharacteristic? _controlCharacteristic;
    private GattCharacteristic? _statusCharacteristic;
    private GattCharacteristic? _historyControlCharacteristic;
    private GattCharacteristic? _historyStatusCharacteristic;
    private Task? _leaseLoop;

    public NodeConnection(DiscoveredNodeInfo discovered, AllowedNodeRule rule, SidecarApp app, Config config)
    {
        _discovered = discovered;
        _rule = rule;
        _app = app;
        _config = config;
    }

    public string? SessionId { get; private set; }

    public string? DeviceId { get; private set; }

    public async Task ConnectIfNeededAsync(CancellationToken shutdownToken)
    {
        await _connectGate.WaitAsync(shutdownToken);

        try
        {
            if (_device is not null && _device.ConnectionStatus == BluetoothConnectionStatus.Connected && SessionId is not null)
            {
                return;
            }

            await _app.EmitNodeConnectionStateAsync(_discovered, "connecting", bootId: null);

            await DisposeRuntimeAsync();

            _device = await WithTimeout(
                BluetoothLEDevice.FromBluetoothAddressAsync(_discovered.BluetoothAddress).AsTask(),
                TimeSpan.FromSeconds(8),
                shutdownToken);

            if (_device is null)
            {
                await _app.EmitNodeConnectionStateAsync(_discovered, "disconnected", bootId: null, reason: "Device connection failed.");
                return;
            }

            _device.ConnectionStatusChanged += OnConnectionStatusChanged;

            _runtimeService = await GetRequiredServiceAsync(_device, _config.RuntimeServiceUuid, shutdownToken);
            _historyService = await GetRequiredServiceAsync(_device, _config.HistoryServiceUuid, shutdownToken, required: false);

            _telemetryCharacteristic = await GetRequiredCharacteristicAsync(_runtimeService, _config.TelemetryUuid, shutdownToken);
            _controlCharacteristic = await GetRequiredCharacteristicAsync(_runtimeService, _config.ControlUuid, shutdownToken);
            _statusCharacteristic = await GetRequiredCharacteristicAsync(_runtimeService, _config.StatusUuid, shutdownToken);

            if (_historyService is not null)
            {
                _historyControlCharacteristic = await GetRequiredCharacteristicAsync(_historyService, _config.HistoryControlUuid, shutdownToken, required: false);
                _historyStatusCharacteristic = await GetRequiredCharacteristicAsync(_historyService, _config.HistoryStatusUuid, shutdownToken, required: false);
            }

            await SubscribeAsync(_telemetryCharacteristic, OnTelemetryChanged, shutdownToken);
            await SubscribeAsync(_statusCharacteristic, OnRuntimeStatusChanged, shutdownToken);

            if (_historyStatusCharacteristic is not null)
            {
                await SubscribeAsync(_historyStatusCharacteristic, OnHistoryStatusChanged, shutdownToken);
            }

            var initialStatus = await ReadCharacteristicJsonAsync(_statusCharacteristic, shutdownToken);
            await _app.EmitLogAsync("info", "Read runtime status before app-session-begin.", new
            {
                node = _discovered.NodeId,
                status = initialStatus,
            });

            var sessionId = RandomHexToken(16);
            var sessionNonce = RandomHexToken(16);

            var began = await WriteControlAsync(JsonSerializer.Serialize(new
            {
                type = "app-session-begin",
                sessionId = sessionId,
                sessionNonce = sessionNonce,
                expiresInMs = 15000,
            }), shutdownToken);

            if (!began)
            {
                await _app.EmitNodeConnectionStateAsync(_discovered, "disconnected", bootId: null, reason: "app-session-begin write failed.");
                return;
            }

            await _app.EmitLogAsync("info", "Wrote app-session-begin over .NET WinRT companion.", new
            {
                node = _discovered.NodeId,
                sessionId,
                sessionNonce,
            });

            var verified = await PollRuntimeStatusForSessionAsync(sessionId, sessionNonce, shutdownToken);

            if (verified is null)
            {
                await _app.EmitNodeConnectionStateAsync(_discovered, "disconnected", bootId: null, reason: "Session token never became visible.");
                return;
            }

            SessionId = sessionId;
            DeviceId = verified["deviceId"]?.GetValue<string>();
            var bootId = verified["bootId"]?.GetValue<string>();

            await _app.EmitNodeConnectionStateAsync(_discovered, "connected", bootId);
            _leaseLoop = Task.Run(() => RunLeaseLoopAsync(_lifetime.Token));
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            await _app.EmitLogAsync("error", "Failed to connect approved node via .NET WinRT companion.", new
            {
                ruleId = _rule.Id,
                node = _discovered.NodeId,
                error = error.Message,
            });
            await _app.EmitNodeConnectionStateAsync(_discovered, "disconnected", bootId: null, reason: error.Message);
            await DisposeRuntimeAsync();
        }
        finally
        {
            _connectGate.Release();
        }
    }

    public async Task<bool> WriteHistoryControlAsync(string payload, CancellationToken shutdownToken)
    {
        if (_historyControlCharacteristic is null)
        {
            return false;
        }

        return await WriteFramedJsonAsync(_historyControlCharacteristic, payload, shutdownToken);
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        await DisposeRuntimeAsync();
    }

    private async Task DisposeRuntimeAsync()
    {
        if (_leaseLoop is not null)
        {
            try
            {
                await _leaseLoop;
            }
            catch
            {
            }

            _leaseLoop = null;
        }

        if (_telemetryCharacteristic is not null)
        {
            _telemetryCharacteristic.ValueChanged -= OnTelemetryChanged;
        }

        if (_statusCharacteristic is not null)
        {
            _statusCharacteristic.ValueChanged -= OnRuntimeStatusChanged;
        }

        if (_historyStatusCharacteristic is not null)
        {
            _historyStatusCharacteristic.ValueChanged -= OnHistoryStatusChanged;
        }

        if (_device is not null)
        {
            _device.ConnectionStatusChanged -= OnConnectionStatusChanged;
        }

        _telemetryCharacteristic = null;
        _controlCharacteristic = null;
        _statusCharacteristic = null;
        _historyControlCharacteristic = null;
        _historyStatusCharacteristic = null;

        _runtimeService?.Dispose();
        _historyService?.Dispose();
        _device?.Dispose();

        _runtimeService = null;
        _historyService = null;
        _device = null;
        SessionId = null;
        DeviceId = null;
    }

    private async Task<GattDeviceService?> GetRequiredServiceAsync(
        BluetoothLEDevice device,
        Guid uuid,
        CancellationToken shutdownToken,
        bool required = true)
    {
        var result = await WithTimeout(
            device.GetGattServicesForUuidAsync(uuid, BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status == GattCommunicationStatus.Success && result.Services.Count > 0)
        {
            return result.Services[0];
        }

        if (!required)
        {
            return null;
        }

        throw new InvalidOperationException($"Required GATT service {uuid} was not available.");
    }

    private async Task<GattCharacteristic?> GetRequiredCharacteristicAsync(
        GattDeviceService? service,
        Guid uuid,
        CancellationToken shutdownToken,
        bool required = true)
    {
        if (service is null)
        {
            return null;
        }

        var result = await WithTimeout(
            service.GetCharacteristicsForUuidAsync(uuid, BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status == GattCommunicationStatus.Success && result.Characteristics.Count > 0)
        {
            return result.Characteristics[0];
        }

        if (!required)
        {
            return null;
        }

        throw new InvalidOperationException($"Required GATT characteristic {uuid} was not available.");
    }

    private async Task SubscribeAsync(
        GattCharacteristic characteristic,
        TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs> handler,
        CancellationToken shutdownToken)
    {
        characteristic.ValueChanged += handler;
        var descriptorMode = characteristic.CharacteristicProperties.HasFlag(GattCharacteristicProperties.Indicate)
            ? GattClientCharacteristicConfigurationDescriptorValue.Indicate
            : GattClientCharacteristicConfigurationDescriptorValue.Notify;

        var result = await WithTimeout(
            characteristic.WriteClientCharacteristicConfigurationDescriptorAsync(descriptorMode).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result != GattCommunicationStatus.Success)
        {
            throw new InvalidOperationException($"CCCD write failed for {characteristic.Uuid}: {result}");
        }
    }

    private async Task<bool> WriteControlAsync(string payload, CancellationToken shutdownToken)
    {
        if (_controlCharacteristic is null)
        {
            return false;
        }

        return await WriteFramedJsonAsync(_controlCharacteristic, payload, shutdownToken);
    }

    private static async Task<bool> WriteAsync(GattCharacteristic characteristic, string payload, CancellationToken shutdownToken)
    {
        var buffer = CryptographicBuffer.ConvertStringToBinary(payload, BinaryStringEncoding.Utf8);
        var result = await WithTimeout(
            characteristic.WriteValueWithResultAsync(buffer, GattWriteOption.WriteWithoutResponse).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        return result.Status == GattCommunicationStatus.Success;
    }

    private static async Task<bool> WriteFramedJsonAsync(GattCharacteristic characteristic, string payload, CancellationToken shutdownToken)
    {
        var frames = BuildControlFrames(payload);

        foreach (var frame in frames)
        {
            var buffer = CryptographicBuffer.CreateFromByteArray(frame);
            var result = await WithTimeout(
                characteristic.WriteValueWithResultAsync(buffer, GattWriteOption.WriteWithResponse).AsTask(),
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

    private async Task<JsonObject?> PollRuntimeStatusForSessionAsync(string sessionId, string sessionNonce, CancellationToken shutdownToken)
    {
        if (_statusCharacteristic is null)
        {
            return null;
        }

        var deadline = DateTimeOffset.UtcNow.AddSeconds(8);
        JsonObject? lastObserved = null;

        while (DateTimeOffset.UtcNow < deadline && !shutdownToken.IsCancellationRequested)
        {
            var payload = await ReadCharacteristicJsonAsync(_statusCharacteristic, shutdownToken);

            if (payload is not null)
            {
                lastObserved = payload;
                var observedSessionId = payload["sessionId"]?.GetValue<string>();
                var observedSessionNonce = payload["sessionNonce"]?.GetValue<string>();

                if (string.Equals(observedSessionId, sessionId, StringComparison.Ordinal) &&
                    string.Equals(observedSessionNonce, sessionNonce, StringComparison.Ordinal))
                {
                    return payload;
                }
            }

            await Task.Delay(250, shutdownToken);
        }

        await _app.EmitLogAsync("warn", "Session token never became visible from runtime status polling.", new
        {
            node = _discovered.NodeId,
            expectedSessionId = sessionId,
            expectedSessionNonce = sessionNonce,
            lastObservedStatus = lastObserved,
        });

        return null;
    }

    private async Task RunLeaseLoopAsync(CancellationToken lifetimeToken)
    {
        if (SessionId is null)
        {
            return;
        }

        while (!lifetimeToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(5), lifetimeToken);

            if (SessionId is null)
            {
                return;
            }

            var wrote = await WriteControlAsync(JsonSerializer.Serialize(new
            {
                type = "app-session-lease",
                sessionId = SessionId,
                expiresInMs = 15000,
            }), lifetimeToken);

            if (!wrote)
            {
                await _app.EmitNodeConnectionStateAsync(_discovered, "disconnected", bootId: null, reason: "Session lease write failed.");
                await DisposeRuntimeAsync();
                return;
            }
        }
    }

    private async void OnConnectionStatusChanged(BluetoothLEDevice sender, object args)
    {
        if (sender.ConnectionStatus == BluetoothConnectionStatus.Connected)
        {
            return;
        }

        await _app.EmitNodeConnectionStateAsync(_discovered, "disconnected", bootId: null, reason: "Bluetooth connection dropped.");
        await DisposeRuntimeAsync();
    }

    private async void OnTelemetryChanged(GattCharacteristic sender, GattValueChangedEventArgs args)
    {
        var payload = ParseJsonBuffer(args.CharacteristicValue);

        if (payload is null)
        {
            return;
        }

        await _app.EmitTelemetryAsync(_discovered, payload);
    }

    private async void OnRuntimeStatusChanged(GattCharacteristic sender, GattValueChangedEventArgs args)
    {
        var payload = ParseJsonBuffer(args.CharacteristicValue);

        if (payload is null)
        {
            return;
        }

        var type = payload["type"]?.GetValue<string>();

        if (string.Equals(type, "board-log", StringComparison.Ordinal))
        {
            await _app.EmitLogAsync("info", payload["message"]?.GetValue<string>() ?? "Board log", new
            {
                deviceId = payload["deviceId"]?.GetValue<string>(),
                source = "board:runtime",
            });
        }
    }

    private async void OnHistoryStatusChanged(GattCharacteristic sender, GattValueChangedEventArgs args)
    {
        var payload = ParseJsonBuffer(args.CharacteristicValue);

        if (payload is null)
        {
            return;
        }

        var type = payload["type"]?.GetValue<string>();
        var deviceId = payload["deviceId"]?.GetValue<string>() ?? DeviceId ?? _discovered.KnownDeviceId ?? _discovered.NodeId;

        switch (type)
        {
            case "history-record":
                if (payload["record"] is not null && payload["requestId"] is JsonNode requestNode)
                {
                    await _app.EmitHistoryRecordAsync(_discovered, deviceId, requestNode.GetValue<string>(), payload["record"]!);
                }
                break;
            case "history-page-complete":
                await _app.EmitHistorySyncCompleteAsync(_discovered, payload);
                break;
            case "history-error":
                await _app.EmitEventAsync(new
                {
                    type = "history_error",
                    node = _discovered.ToProtocolNode(),
                    payload,
                });
                break;
        }
    }

    private static async Task<JsonObject?> ReadCharacteristicJsonAsync(GattCharacteristic characteristic, CancellationToken shutdownToken)
    {
        var result = await WithTimeout(
            characteristic.ReadValueAsync(BluetoothCacheMode.Uncached).AsTask(),
            TimeSpan.FromSeconds(8),
            shutdownToken);

        if (result.Status != GattCommunicationStatus.Success)
        {
            return null;
        }

        return ParseJsonBuffer(result.Value);
    }

    private static JsonObject? ParseJsonBuffer(IBuffer buffer)
    {
        CryptographicBuffer.CopyToByteArray(buffer, out byte[] bytes);
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

        try
        {
            return JsonNode.Parse(text) as JsonObject;
        }
        catch
        {
            return null;
        }
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

internal sealed record Config(
    Guid RuntimeServiceUuid,
    Guid TelemetryUuid,
    Guid ControlUuid,
    Guid StatusUuid,
    Guid HistoryServiceUuid,
    Guid HistoryControlUuid,
    Guid HistoryStatusUuid,
    string DeviceNamePrefix)
{
    public static Config FromEnvironment() => new(
        RuntimeServiceUuid: ReadGuid("BLE_RUNTIME_SERVICE_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001"),
        TelemetryUuid: ReadGuid("BLE_TELEMETRY_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002"),
        ControlUuid: ReadGuid("BLE_CONTROL_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003"),
        StatusUuid: ReadGuid("BLE_STATUS_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7004"),
        HistoryServiceUuid: ReadGuid("BLE_HISTORY_SERVICE_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7101"),
        HistoryControlUuid: ReadGuid("BLE_HISTORY_CONTROL_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7102"),
        HistoryStatusUuid: ReadGuid("BLE_HISTORY_STATUS_UUID", "4b2f41d1-6f1b-4d3a-92e5-7db4891f7103"),
        DeviceNamePrefix: Environment.GetEnvironmentVariable("BLE_DEVICE_NAME_PREFIX") ?? "GymMotion-");

    private static Guid ReadGuid(string name, string fallback)
        => Guid.Parse(Environment.GetEnvironmentVariable(name) ?? fallback);
}
