using Linux.Bluetooth;

namespace GymMotion.LinuxBleGateway;

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
