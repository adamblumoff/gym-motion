using System.Text;
using Xunit;

namespace GymMotion.LinuxBleGateway.Tests;

public sealed class GatewayTelemetryPayloadTests
{
    [Fact]
    public void TryReadAcceptsNoisyBlePayloadAndBuildsMotionIngest()
    {
        var bytes = Encoding.UTF8.GetBytes("\0noise {\"state\":\"down\",\"timestamp\":123,\"delta\":7,\"sequence\":3}\0");

        var telemetry = GatewayTelemetryPayload.TryRead(bytes, "node-1");

        Assert.NotNull(telemetry);
        Assert.True(telemetry.HasRequiredFields);
        Assert.False(telemetry.IsHeartbeat("up"));
        Assert.Equal(new Dictionary<string, object?>
        {
            ["deviceId"] = "node-1",
            ["gatewayId"] = "gateway-1",
            ["state"] = "down",
            ["timestamp"] = 123L,
            ["delta"] = 7L,
            ["sequence"] = 3L,
        }, telemetry.ToMotionPayload("gateway-1"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("\0\0")]
    [InlineData("node telemetry unavailable")]
    public void TryReadIgnoresEmptyOrNonJsonPayloads(string text)
    {
        var telemetry = GatewayTelemetryPayload.TryRead(Encoding.UTF8.GetBytes(text), "node-1");

        Assert.Null(telemetry);
    }

    [Theory]
    [InlineData("{\"deviceId\":\"node-1\",\"timestamp\":123}")]
    [InlineData("{\"deviceId\":\"node-1\",\"state\":\"down\"}")]
    public void MissingStateOrTimestampIsInvalid(string json)
    {
        var telemetry = GatewayTelemetryPayload.TryRead(Encoding.UTF8.GetBytes(json), null);

        Assert.NotNull(telemetry);
        Assert.False(telemetry.HasRequiredFields);
    }

    [Fact]
    public void SnapshotPayloadBuildsHeartbeat()
    {
        var bytes = Encoding.UTF8.GetBytes("""
            {
              "deviceId": "node-1",
              "state": "down",
              "timestamp": 123,
              "snapshot": true,
              "bootId": "boot-1",
              "firmwareVersion": "1.2.3",
              "hardwareId": "bench-a"
            }
            """);

        var telemetry = GatewayTelemetryPayload.TryRead(bytes, null);

        Assert.NotNull(telemetry);
        Assert.True(telemetry.IsHeartbeat("up"));
        Assert.Equal(new Dictionary<string, object?>
        {
            ["deviceId"] = "node-1",
            ["gatewayId"] = "gateway-1",
            ["timestamp"] = 123L,
            ["bootId"] = "boot-1",
            ["firmwareVersion"] = "1.2.3",
            ["hardwareId"] = "bench-a",
        }, telemetry.ToHeartbeatPayload("gateway-1"));
    }

    [Fact]
    public void RepeatedMotionStateBuildsHeartbeat()
    {
        var bytes = Encoding.UTF8.GetBytes("{\"deviceId\":\"node-1\",\"state\":\"down\",\"timestamp\":123}");

        var telemetry = GatewayTelemetryPayload.TryRead(bytes, null);

        Assert.NotNull(telemetry);
        Assert.True(telemetry.IsHeartbeat("down"));
    }

    [Fact]
    public void MotionPayloadCopiesOnlyPresentOptionalFields()
    {
        var bytes = Encoding.UTF8.GetBytes("""
            {
              "deviceId": "node-1",
              "state": "up",
              "timestamp": 456,
              "delta": 9,
              "sequence": 4,
              "sensorIssue": "",
              "bootId": "boot-2"
            }
            """);

        var telemetry = GatewayTelemetryPayload.TryRead(bytes, null);

        Assert.NotNull(telemetry);
        Assert.Equal(new Dictionary<string, object?>
        {
            ["deviceId"] = "node-1",
            ["gatewayId"] = "gateway-1",
            ["state"] = "up",
            ["timestamp"] = 456L,
            ["delta"] = 9L,
            ["sequence"] = 4L,
            ["bootId"] = "boot-2",
        }, telemetry.ToMotionPayload("gateway-1"));
    }
}
