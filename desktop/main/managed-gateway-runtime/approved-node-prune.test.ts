import { describe, expect, it } from "vitest";

import type { DesktopSnapshot } from "@core/contracts";

import { pruneForgottenDevicesFromSnapshot } from "./approved-node-prune";
import { createEmptySnapshot } from "./snapshot";

function createSnapshot(): DesktopSnapshot {
  return {
    ...createEmptySnapshot(),
    runtimeState: "running",
    liveStatus: "Gateway live",
    gateway: {
      ...createEmptySnapshot().gateway,
      adapterState: "poweredOn",
      connectedNodeCount: 1,
      reconnectingNodeCount: 0,
      knownNodeCount: 1,
    },
    devices: [
      {
        id: "esp32-1",
        lastState: "still",
        lastSeenAt: Date.now(),
        lastDelta: null,
        updatedAt: new Date().toISOString(),
        hardwareId: "hw-1",
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        machineLabel: null,
        siteId: null,
        provisioningState: "provisioned",
        updateStatus: "idle",
        updateTargetVersion: null,
        updateDetail: null,
        updateUpdatedAt: null,
        lastHeartbeatAt: null,
        lastEventReceivedAt: new Date().toISOString(),
        healthStatus: "online",
        gatewayConnectionState: "connected",
        telemetryFreshness: "fresh",
        peripheralId: "peripheral-1",
        address: "AA:BB",
        gatewayLastAdvertisementAt: null,
        gatewayLastConnectedAt: new Date().toISOString(),
        gatewayLastDisconnectedAt: null,
        gatewayLastTelemetryAt: new Date().toISOString(),
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
        reconnectAttempt: 0,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
      },
    ],
    events: [
      {
        id: 1,
        deviceId: "esp32-1",
        sequence: 10,
        state: "moving",
        delta: 8,
        eventTimestamp: Date.now(),
        receivedAt: new Date().toISOString(),
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    ],
    logs: [
      {
        id: 1,
        deviceId: "esp32-1",
        sequence: 10,
        level: "info",
        code: "runtime.connected",
        message: "Connected",
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
        deviceTimestamp: Date.now(),
        metadata: null,
        receivedAt: new Date().toISOString(),
      },
    ],
    activities: [
      {
        id: "activity-1",
        deviceId: "esp32-1",
        sequence: 10,
        kind: "motion",
        title: "MOVING",
        message: "Gateway recorded moving for esp32-1.",
        state: "moving",
        level: null,
        code: "motion.state",
        delta: 8,
        eventTimestamp: Date.now(),
        receivedAt: new Date().toISOString(),
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
        metadata: null,
      },
    ],
  };
}

describe("approved-node-prune", () => {
  it("purges forgotten devices and their live runtime data from the snapshot", () => {
    const snapshot = createSnapshot();

    const nextSnapshot = pruneForgottenDevicesFromSnapshot(snapshot, []);

    expect(nextSnapshot.devices).toHaveLength(0);
    expect(nextSnapshot.events).toHaveLength(0);
    expect(nextSnapshot.logs).toHaveLength(0);
    expect(nextSnapshot.activities).toHaveLength(0);
    expect(nextSnapshot.gateway.connectedNodeCount).toBe(0);
    expect(nextSnapshot.gateway.knownNodeCount).toBe(0);
  });
});
