import { describe, expect, it } from "bun:test";

import type { GatewayRuntimeDeviceSummary } from "@core/contracts";

import {
  buildNodeLogs,
  displayDiscoveryAddress,
  displayDiscoveryName,
  displayNodeAddress,
  displayNodeName,
  rssiToPercent,
  shouldDisplayDashboardDevice,
} from "./shared";

describe("selector shared helpers", () => {
  it("normalizes RSSI values into a bounded percentage", () => {
    expect(rssiToPercent(null)).toBeNull();
    expect(rssiToPercent(-100)).toBe(0);
    expect(rssiToPercent(-55)).toBeGreaterThan(0);
    expect(rssiToPercent(-20)).toBe(100);
  });

  it("prefers machine labels and BLE addresses for runtime devices", () => {
    const device: GatewayRuntimeDeviceSummary = {
      id: "stack-001",
      machineLabel: "Leg Press",
      siteId: "Dallas",
      advertisedName: "GymMotion-f4e9d4",
      address: "AA:BB",
      peripheralId: "peripheral-1",
      lastState: "still",
      lastSeenAt: null,
      lastDelta: null,
      updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
      hardwareId: "hw-1",
      bootId: "boot-1",
      firmwareVersion: "0.5.2",
      provisioningState: "provisioned",
      updateStatus: "idle",
      updateTargetVersion: null,
      updateDetail: null,
      updateUpdatedAt: null,
      lastHeartbeatAt: null,
      lastEventReceivedAt: null,
      healthStatus: "healthy",
      gatewayConnectionState: "connected",
      telemetryFreshness: "fresh",
      gatewayLastAdvertisementAt: null,
      gatewayLastConnectedAt: null,
      gatewayLastDisconnectedAt: null,
      gatewayLastTelemetryAt: null,
      gatewayDisconnectReason: null,
      lastRssi: null,
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
    };

    expect(displayNodeName(device)).toBe("Leg Press");
    expect(displayNodeAddress(device)).toBe("AA:BB");
  });

  it("uses discovery fallbacks in the right order", () => {
    expect(
      displayDiscoveryName({
        id: "candidate-1",
        label: "Visible node",
        machineLabel: null,
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      }),
    ).toBe("GymMotion-f4e9d4");

    expect(
      displayDiscoveryAddress({
        id: "candidate-1",
        address: null,
        peripheralId: "peripheral-1",
        knownDeviceId: null,
      }),
    ).toBe("peripheral-1");
  });

  it("builds recent device logs from activities", () => {
    const logs = buildNodeLogs(
      {
        id: "stack-001",
        machineLabel: "Leg Press",
        siteId: null,
        advertisedName: null,
        address: null,
        peripheralId: null,
        lastState: "still",
        lastSeenAt: null,
        lastDelta: null,
        updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        hardwareId: "hw-1",
        bootId: "boot-1",
        firmwareVersion: "0.5.2",
        provisioningState: "provisioned",
        updateStatus: "idle",
        updateTargetVersion: null,
        updateDetail: null,
        updateUpdatedAt: null,
        lastHeartbeatAt: null,
        lastEventReceivedAt: null,
        healthStatus: "healthy",
        gatewayConnectionState: "connected",
        telemetryFreshness: "fresh",
        gatewayLastAdvertisementAt: null,
        gatewayLastConnectedAt: null,
        gatewayLastDisconnectedAt: null,
        gatewayLastTelemetryAt: null,
        gatewayDisconnectReason: null,
        lastRssi: null,
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
      [
        {
          id: "activity-1",
          deviceId: "stack-001",
          state: "moving",
          message: "Movement detected",
          receivedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        },
      ],
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.isMoving).toBe(true);
    expect(logs[0]?.message).toBe("Movement detected");
  });

  it("filters dashboard devices by approved-node identity when provided", () => {
    const device: GatewayRuntimeDeviceSummary = {
      id: "stack-001",
      machineLabel: "Leg Press",
      siteId: null,
      advertisedName: "GymMotion-f4e9d4",
      address: "AA:BB",
      peripheralId: "peripheral-1",
      lastState: "still",
      lastSeenAt: null,
      lastDelta: null,
      updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
      hardwareId: "hw-1",
      bootId: "boot-1",
      firmwareVersion: "0.5.2",
      provisioningState: "provisioned",
      updateStatus: "idle",
      updateTargetVersion: null,
      updateDetail: null,
      updateUpdatedAt: null,
      lastHeartbeatAt: null,
      lastEventReceivedAt: null,
      healthStatus: "healthy",
      gatewayConnectionState: "connected",
      telemetryFreshness: "fresh",
      gatewayLastAdvertisementAt: null,
      gatewayLastConnectedAt: null,
      gatewayLastDisconnectedAt: null,
      gatewayLastTelemetryAt: null,
      gatewayDisconnectReason: null,
      lastRssi: null,
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
    };

    expect(
      shouldDisplayDashboardDevice(device, [
        {
          id: "known:stack-001",
          label: "Leg Press",
          knownDeviceId: "stack-001",
          peripheralId: "peripheral-1",
          address: "AA:BB",
          localName: "GymMotion-f4e9d4",
        },
      ]),
    ).toBe(true);
    expect(shouldDisplayDashboardDevice(device, [])).toBe(false);
  });
});
