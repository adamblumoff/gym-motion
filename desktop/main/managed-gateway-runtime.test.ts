import { describe, expect, it } from "bun:test";

import { mergeRepositoryDeviceIntoGatewaySnapshot } from "./gateway-snapshot";

describe("managed gateway runtime snapshot merge", () => {
  it("keeps first telemetry-only updates disconnected until transport reconnects", () => {
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

    expect(device.gatewayConnectionState).toBe("disconnected");
    expect(device.telemetryFreshness).toBe("fresh");
    expect(device.gatewayLastTelemetryAt).toBe(timestamp);
  });

  it("refreshes telemetry freshness when repository updates advance the receipt timestamp", () => {
    const staleTimestamp = new Date("2026-03-14T10:00:00.000Z").toISOString();
    const freshTimestamp = new Date().toISOString();

    const device = mergeRepositoryDeviceIntoGatewaySnapshot(
      [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: Date.parse(staleTimestamp),
          lastDelta: null,
          updatedAt: staleTimestamp,
          hardwareId: "hw-1",
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          machineLabel: null,
          siteId: null,
          provisioningState: "provisioned",
          updateStatus: "idle",
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: staleTimestamp,
          healthStatus: "stale",
          gatewayConnectionState: "connected",
          telemetryFreshness: "stale",
          peripheralId: "peripheral-1",
          address: "AA:BB:CC:DD",
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: staleTimestamp,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: staleTimestamp,
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -58,
          otaStatus: "idle",
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
        },
      ],
      {
        id: "stack-001",
        lastState: "moving",
        lastSeenAt: Date.now(),
        lastDelta: 12,
        updatedAt: freshTimestamp,
        hardwareId: "hw-1",
        bootId: "boot-1",
        firmwareVersion: "0.5.1",
        machineLabel: null,
        siteId: null,
        provisioningState: "provisioned",
        updateStatus: "idle",
        updateTargetVersion: null,
        updateDetail: null,
        updateUpdatedAt: null,
        lastHeartbeatAt: null,
        lastEventReceivedAt: freshTimestamp,
        healthStatus: "online",
      },
    );

    expect(device.telemetryFreshness).toBe("fresh");
    expect(device.gatewayLastTelemetryAt).toBe(freshTimestamp);
    expect(device.address).toBe("AA:BB:CC:DD");
  });
});
