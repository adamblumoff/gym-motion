import { describe, expect, it, vi } from "vitest";

import { createEmptySnapshot } from "./snapshot";
import { createRuntimeSync } from "./runtime-sync";

describe("createRuntimeSync", () => {
  it("loads recent global activity without per-device fanout", async () => {
    let snapshot = createEmptySnapshot();
    const listDeviceActivity = vi.fn();
    const listRecentActivity = vi.fn(async () => [
      {
        id: "motion-1",
        deviceId: "stack-001",
        sequence: 1,
        kind: "motion" as const,
        title: "MOVING",
        message: "Gateway recorded moving for stack-001.",
        state: "moving" as const,
        level: null,
        code: "motion.state",
        delta: 3,
        eventTimestamp: 123,
        receivedAt: "2026-03-18T12:00:00.000Z",
        bootId: "boot-1",
        firmwareVersion: "1.0.0",
        hardwareId: "hw-1",
        metadata: { delta: 3 },
      },
    ]);

    const runtimeSync = createRuntimeSync({
      getSnapshot: () => snapshot,
      setSnapshot: (nextSnapshot) => {
        snapshot = nextSnapshot;
      },
      listDevices: async () => [],
      listRecentEvents: async () => [],
      listDeviceLogs: async () => [],
      listDeviceActivity,
      listRecentActivity,
    });

    await runtimeSync.refreshSnapshotData();

    expect(listRecentActivity).toHaveBeenCalledOnce();
    expect(listDeviceActivity).not.toHaveBeenCalled();
    expect(snapshot.activities).toHaveLength(1);
  });

  it("refreshes only the affected device runtime data", async () => {
    let snapshot = {
      ...createEmptySnapshot(),
      devices: [
        {
          id: "stack-001",
          lastState: "still" as const,
          lastSeenAt: 1,
          lastDelta: null,
          updatedAt: "2026-03-18T12:00:00.000Z",
          hardwareId: "hw-1",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          machineLabel: "Leg Press",
          siteId: "floor-a",
          provisioningState: "assigned" as const,
          updateStatus: "idle" as const,
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: "2026-03-18T12:00:01.000Z",
          healthStatus: "online" as const,
          gatewayConnectionState: "disconnected" as const,
          telemetryFreshness: "fresh" as const,
          peripheralId: null,
          address: null,
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: null,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: null,
          gatewayDisconnectReason: null,
          advertisedName: null,
          lastRssi: null,
          otaStatus: "idle" as const,
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 3,
          reconnectRetryExhausted: false,
          reconnectAwaitingDecision: false,
        },
        {
          id: "stack-002",
          lastState: "moving" as const,
          lastSeenAt: 2,
          lastDelta: 3,
          updatedAt: "2026-03-18T12:05:00.000Z",
          hardwareId: "hw-2",
          bootId: "boot-2",
          firmwareVersion: "1.0.0",
          machineLabel: "Row",
          siteId: "floor-b",
          provisioningState: "assigned" as const,
          updateStatus: "idle" as const,
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: "2026-03-18T12:05:01.000Z",
          healthStatus: "online" as const,
          gatewayConnectionState: "disconnected" as const,
          telemetryFreshness: "fresh" as const,
          peripheralId: null,
          address: null,
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: null,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: null,
          gatewayDisconnectReason: null,
          advertisedName: null,
          lastRssi: null,
          otaStatus: "idle" as const,
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 3,
          reconnectRetryExhausted: false,
          reconnectAwaitingDecision: false,
        },
      ],
      events: [
        {
          id: 20,
          deviceId: "stack-002",
          sequence: 20,
          state: "moving" as const,
          delta: 3,
          eventTimestamp: 20,
          receivedAt: "2026-03-18T12:05:01.000Z",
          bootId: "boot-2",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-2",
        },
        {
          id: 10,
          deviceId: "stack-001",
          sequence: 10,
          state: "still" as const,
          delta: 0,
          eventTimestamp: 10,
          receivedAt: "2026-03-18T12:00:01.000Z",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
        },
      ],
      logs: [
        {
          id: 30,
          deviceId: "stack-002",
          sequence: 30,
          level: "info" as const,
          code: "runtime.ok",
          message: "Row ready",
          bootId: "boot-2",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-2",
          deviceTimestamp: 30,
          metadata: null,
          receivedAt: "2026-03-18T12:05:02.000Z",
        },
        {
          id: 11,
          deviceId: "stack-001",
          sequence: 11,
          level: "info" as const,
          code: "runtime.ok",
          message: "Leg Press ready",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
          deviceTimestamp: 11,
          metadata: null,
          receivedAt: "2026-03-18T12:00:02.000Z",
        },
      ],
      activities: [
        {
          id: "log-30",
          deviceId: "stack-002",
          sequence: 30,
          kind: "lifecycle" as const,
          title: "runtime.ok",
          message: "Row ready",
          state: null,
          level: "info" as const,
          code: "runtime.ok",
          delta: null,
          eventTimestamp: 30,
          receivedAt: "2026-03-18T12:05:02.000Z",
          bootId: "boot-2",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-2",
          metadata: null,
        },
        {
          id: "motion-10",
          deviceId: "stack-001",
          sequence: 10,
          kind: "motion" as const,
          title: "STILL",
          message: "Gateway recorded still for stack-001.",
          state: "still" as const,
          level: null,
          code: "motion.state",
          delta: 0,
          eventTimestamp: 10,
          receivedAt: "2026-03-18T12:00:01.000Z",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
          metadata: { delta: 0 },
        },
      ],
    };

    const runtimeSync = createRuntimeSync({
      getSnapshot: () => snapshot,
      setSnapshot: (nextSnapshot) => {
        snapshot = nextSnapshot;
      },
      getDevice: async (deviceId) =>
        deviceId === "stack-001"
          ? {
              id: "stack-001",
              lastState: "moving",
              lastSeenAt: 100,
              lastDelta: 5,
              updatedAt: "2026-03-18T12:10:00.000Z",
              hardwareId: "hw-1",
              bootId: "boot-1",
              firmwareVersion: "1.1.0",
              machineLabel: "Leg Press",
              siteId: "floor-a",
              provisioningState: "assigned",
              updateStatus: "idle",
              updateTargetVersion: null,
              updateDetail: null,
              updateUpdatedAt: null,
              lastHeartbeatAt: null,
              lastEventReceivedAt: "2026-03-18T12:10:01.000Z",
              healthStatus: "online",
            }
          : null,
      listDeviceRecentEvents: async ({ deviceId }) =>
        deviceId === "stack-001"
          ? [
              {
                id: 12,
                deviceId: "stack-001",
                sequence: null,
                state: "moving",
                delta: 5,
                eventTimestamp: 100,
                receivedAt: "2026-03-18T12:10:01.000Z",
                bootId: "boot-1",
                firmwareVersion: "1.1.0",
                hardwareId: "hw-1",
              },
            ]
          : [],
      listDeviceLogs: async ({ deviceId }) =>
        deviceId === "stack-001"
          ? [
              {
                id: 13,
                deviceId: "stack-001",
                sequence: null,
                level: "info",
                code: "runtime.connected",
                message: "Leg Press connected",
                bootId: "boot-1",
                firmwareVersion: "1.1.0",
                hardwareId: "hw-1",
                deviceTimestamp: 101,
                metadata: null,
                receivedAt: "2026-03-18T12:10:02.000Z",
              },
            ]
          : [],
      listDeviceActivity: async ({ deviceId }) =>
        deviceId === "stack-001"
          ? [
              {
                id: "log-13",
                deviceId: "stack-001",
                sequence: null,
                kind: "lifecycle",
                title: "runtime.connected",
                message: "Leg Press connected",
                state: null,
                level: "info",
                code: "runtime.connected",
                delta: null,
                eventTimestamp: 101,
                receivedAt: "2026-03-18T12:10:02.000Z",
                bootId: "boot-1",
                firmwareVersion: "1.1.0",
                hardwareId: "hw-1",
                metadata: null,
              },
            ]
          : [],
    });

    await runtimeSync.refreshDeviceData("stack-001");

    expect(snapshot.events.map((event) => event.id)).toEqual([12, 20]);
    expect(snapshot.logs.map((log) => log.id)).toEqual([13, 30]);
    expect(snapshot.activities.map((activity) => activity.id)).toEqual(["log-13", "log-30"]);
    expect(snapshot.devices[0]?.id).toBe("stack-001");
    expect(snapshot.devices.find((device) => device.id === "stack-001")?.firmwareVersion).toBe("1.1.0");
    expect(snapshot.devices.find((device) => device.id === "stack-002")?.firmwareVersion).toBe("1.0.0");
  });
});
