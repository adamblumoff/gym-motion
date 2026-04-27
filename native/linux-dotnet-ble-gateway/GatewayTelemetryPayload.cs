using System.Text.Json;

namespace GymMotion.LinuxBleGateway;

internal sealed record GatewayTelemetryPayload(
    JsonElement Payload,
    string Text,
    string? DeviceId,
    string? State,
    long? Timestamp)
{
    public bool HasRequiredFields =>
        !string.IsNullOrWhiteSpace(DeviceId) &&
        !string.IsNullOrWhiteSpace(State) &&
        Timestamp is not null;

    public static GatewayTelemetryPayload? TryRead(byte[] bytes, string? fallbackDeviceId)
    {
        if (GatewayJson.ParseElement(bytes) is not JsonElement payload)
        {
            return null;
        }

        return new GatewayTelemetryPayload(
            Payload: payload,
            Text: JsonSerializer.Serialize(payload),
            DeviceId: GatewayJson.GetString(payload, "deviceId") ?? fallbackDeviceId,
            State: GatewayJson.GetString(payload, "state"),
            Timestamp: GatewayJson.GetInt64(payload, "timestamp"));
    }

    public bool IsHeartbeat(string? previousMotionState)
        => GatewayJson.GetBool(Payload, "snapshot") == true ||
            string.Equals(previousMotionState, State, StringComparison.Ordinal);

    public Dictionary<string, object?> ToHeartbeatPayload(string gatewayId)
    {
        var heartbeat = new Dictionary<string, object?>
        {
            ["deviceId"] = DeviceId!,
            ["gatewayId"] = gatewayId,
            ["timestamp"] = Timestamp!.Value,
        };
        CopyOptionalString(heartbeat, "bootId");
        CopyOptionalString(heartbeat, "firmwareVersion");
        CopyOptionalString(heartbeat, "hardwareId");
        return heartbeat;
    }

    public Dictionary<string, object?> ToMotionPayload(string gatewayId)
    {
        var motion = new Dictionary<string, object?>
        {
            ["deviceId"] = DeviceId!,
            ["gatewayId"] = gatewayId,
            ["state"] = State!,
            ["timestamp"] = Timestamp!.Value,
            ["delta"] = GatewayJson.GetInt64(Payload, "delta"),
        };
        CopyOptionalString(motion, "sensorIssue");
        CopyOptionalInt64(motion, "sequence");
        CopyOptionalString(motion, "bootId");
        CopyOptionalString(motion, "firmwareVersion");
        CopyOptionalString(motion, "hardwareId");
        return motion;
    }

    private void CopyOptionalString(Dictionary<string, object?> target, string propertyName)
    {
        var value = GatewayJson.GetString(Payload, propertyName);
        if (!string.IsNullOrWhiteSpace(value))
        {
            target[propertyName] = value;
        }
    }

    private void CopyOptionalInt64(Dictionary<string, object?> target, string propertyName)
    {
        var value = GatewayJson.GetInt64(Payload, propertyName);
        if (value is not null)
        {
            target[propertyName] = value.Value;
        }
    }
}
