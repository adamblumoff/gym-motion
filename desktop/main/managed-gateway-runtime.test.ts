import { describe, expect, it } from "bun:test";

import { mergeRepositoryDeviceIntoGatewaySnapshot } from "./gateway-snapshot";

describe("managed gateway runtime snapshot merge", () => {
  it("treats first telemetry-only updates as fresh discovered devices", () => {
    const timestamp = new Date().toISOString();

    const device = mergeRepositoryDeviceIntoGatewaySnapshot([], {
      id: "stack-001",
      lastState: "moving",
      lastSeenAt: Date.now(),
      lastDelta: 12,
      updatedAt: timestamp,
      hardwareId: "hw-1",
      bootId: "boot-1",
      firmwareVersion: "0.5.1",
      machineLabel: null,
      siteId: null,
      provisioningState: "assigned",
      updateStatus: "idle",
      updateTargetVersion: null,
      updateDetail: null,
      updateUpdatedAt: null,
      lastHeartbeatAt: null,
      lastEventReceivedAt: timestamp,
      healthStatus: "online",
    });

    expect(device.gatewayConnectionState).toBe("discovered");
    expect(device.telemetryFreshness).toBe("fresh");
    expect(device.gatewayLastTelemetryAt).toBe(timestamp);
  });
});
