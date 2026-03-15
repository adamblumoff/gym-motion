import { describe, expect, it } from "bun:test";

import type { DesktopSnapshot } from "@core/contracts";

import { buildBluetoothNodes } from "./data";

describe("buildBluetoothNodes", () => {
  it("preserves non-connected gateway states instead of flattening them to offline", () => {
    const snapshot: DesktopSnapshot = {
      liveStatus: "Gateway live",
      trayHint: "Waiting",
      runtimeState: "running",
      gatewayIssue: null,
      gateway: {
        hostname: "test-host",
        mode: "reference-ble-node-gateway",
        sessionId: "session-1",
        adapterState: "poweredOn",
        scanState: "scanning",
        connectedNodeCount: 0,
        reconnectingNodeCount: 1,
        knownNodeCount: 1,
        startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
      },
      devices: [
        {
          id: "stack-001",
          lastState: "moving",
          lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
          lastDelta: 12,
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-1",
          firmwareVersion: "0.5.0",
          machineLabel: "Leg Press",
          siteId: "Dallas",
          provisioningState: "provisioned",
          updateStatus: "idle",
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: null,
          healthStatus: "stale",
          gatewayConnectionState: "reconnecting",
          telemetryFreshness: "fresh",
          peripheralId: "peripheral-1",
          gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -62,
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
      events: [],
      logs: [],
      activities: [],
    };

    const [node] = buildBluetoothNodes(snapshot);

    expect(node?.connectionState).toBe("reconnecting");
    expect(node?.isConnected).toBe(false);
    expect(node?.isMoving).toBe(true);
  });
});
