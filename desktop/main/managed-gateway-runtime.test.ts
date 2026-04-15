import { describe, expect, it } from "vitest";

import {
  mergeRepositoryDeviceIntoGatewaySnapshot,
  mergeRuntimeDeviceIntoGatewaySnapshot,
} from "./gateway-snapshot";

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

  it("clears stale sensor faults when healthy runtime telemetry arrives", () => {
    const timestamp = new Date().toISOString();

    const device = mergeRuntimeDeviceIntoGatewaySnapshot(
      [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: Date.now(),
          lastDelta: null,
          updatedAt: timestamp,
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
          lastEventReceivedAt: null,
          healthStatus: "online",
          gatewayConnectionState: "connected",
          telemetryFreshness: "fresh",
          peripheralId: "peripheral-1",
          address: "AA:BB:CC:DD",
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: timestamp,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: timestamp,
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -58,
          sensorIssue: "sensor_bus_recovery",
          otaStatus: "idle",
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: false,
          reconnectAwaitingDecision: false,
        },
      ],
      {
        deviceId: "stack-001",
        gatewayConnectionState: "connected",
        peripheralId: "peripheral-1",
        address: "AA:BB:CC:DD",
        gatewayLastAdvertisementAt: null,
        gatewayLastConnectedAt: timestamp,
        gatewayLastDisconnectedAt: null,
        gatewayLastTelemetryAt: timestamp,
        gatewayDisconnectReason: null,
        advertisedName: "GymMotion-f4e9d4",
        lastRssi: -58,
        lastState: "still",
        lastSeenAt: Date.now(),
        lastDelta: 12,
        firmwareVersion: "0.5.1",
        bootId: "boot-1",
        hardwareId: "hw-1",
        otaStatus: "idle",
        otaTargetVersion: null,
        otaProgressBytesSent: null,
        otaTotalBytes: null,
        otaLastPhase: null,
        otaFailureDetail: null,
        otaLastStatusMessage: null,
        otaUpdatedAt: null,
        reconnectAttempt: 0,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
        updatedAt: timestamp,
      },
    );

    expect(device.sensorIssue).toBeNull();
    expect(device.lastDelta).toBe(12);
  });
});
