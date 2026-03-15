import { describe, expect, it } from "bun:test";

import type { DesktopSnapshot } from "@core/contracts";

import {
  buildBluetoothNodes,
  buildMovementData,
  buildSignalHistory,
  calculateAverageSignal,
} from "./data";

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

describe("buildMovementData", () => {
  it("buckets motion by device event time instead of receipt time", () => {
    const eventTimestamp = Date.parse("2026-03-14T09:15:00.000Z");
    const expectedHour = `${new Date(eventTimestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
    })}:00`;
    const chart = buildMovementData([
      {
        id: 1,
        deviceId: "stack-001",
        sequence: 1,
        state: "moving",
        delta: 22,
        eventTimestamp,
        receivedAt: new Date("2026-03-14T14:45:00.000Z").toISOString(),
        bootId: "boot-1",
        firmwareVersion: "0.5.1",
        hardwareId: "hw-1",
      },
    ]);

    expect(chart).toEqual([{ hour: expectedHour, movements: 1 }]);
  });
});

describe("calculateAverageSignal", () => {
  it("averages only populated signal slots", () => {
    expect(
      calculateAverageSignal({
        sensorA: 80,
        sensorB: 0,
        sensorC: 0,
        sensorD: 0,
        sensorE: 0,
      }),
    ).toBe(80);
  });
});

describe("buildSignalHistory", () => {
  it("uses event time for chart labels", () => {
    const eventTimestamp = Date.parse("2026-03-14T09:15:00.000Z");
    const expectedTime = new Date(eventTimestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });

    const history = buildSignalHistory(
      [
        {
          id: 1,
          deviceId: "stack-001",
          sequence: 1,
          state: "moving",
          delta: 15,
          eventTimestamp,
          receivedAt: new Date("2026-03-14T14:45:00.000Z").toISOString(),
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      ],
      [
        {
          id: "stack-001",
          name: "Leg Press",
          macAddress: "peripheral-1",
          isConnected: true,
          connectionState: "connected",
          healthStatus: "online",
          telemetryFreshness: "fresh",
          isMoving: true,
          signalStrength: 60,
          batteryLevel: null,
          logs: [],
        },
      ],
    );

    expect(history[0]?.time).toBe(expectedTime);
  });

  it("keeps per-event signal levels for a single active node", () => {
    const history = buildSignalHistory(
      [
        {
          id: 1,
          deviceId: "stack-001",
          sequence: 1,
          state: "moving",
          delta: 10,
          eventTimestamp: Date.parse("2026-03-14T09:15:00.000Z"),
          receivedAt: new Date("2026-03-14T09:15:01.000Z").toISOString(),
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
        {
          id: 2,
          deviceId: "stack-001",
          sequence: 2,
          state: "moving",
          delta: 40,
          eventTimestamp: Date.parse("2026-03-14T09:16:00.000Z"),
          receivedAt: new Date("2026-03-14T09:16:01.000Z").toISOString(),
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      ],
      [
        {
          id: "stack-001",
          name: "Leg Press",
          macAddress: "peripheral-1",
          isConnected: true,
          connectionState: "connected",
          healthStatus: "online",
          telemetryFreshness: "fresh",
          isMoving: true,
          signalStrength: 80,
          batteryLevel: null,
          logs: [],
        },
      ],
    );

    expect(history[0]?.sensorA).toBe(35);
    expect(history[1]?.sensorA).toBe(65);
  });
});
