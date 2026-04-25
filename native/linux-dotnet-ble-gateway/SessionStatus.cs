namespace GymMotion.LinuxBleGateway;

internal sealed record SessionStatus(
    string? Type,
    string? DeviceId,
    string? BootId,
    string? SessionId,
    string? SessionNonce);
