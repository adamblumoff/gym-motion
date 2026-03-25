import { describe, expect, it } from "vitest";

import { createEmptySnapshot } from "./snapshot";
import { createDataEventHandler } from "./data-events";

function createRepositoryDevice(deviceId: string) {
  return {
    id: deviceId,
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
    lastHeartbeatAt: "2026-03-18T12:00:00.000Z",
    lastEventReceivedAt: "2026-03-18T12:00:01.000Z",
    healthStatus: "online" as const,
  };
}

describe("createDataEventHandler", () => {
  it("refreshes analytics immediately for live motion events", () => {
    const emittedEvents: string[] = [];
    const refreshAnalyticsNowCalls: string[] = [];
    const scheduleAnalyticsRefreshCalls: string[] = [];
    const recordLiveMotionCalls: string[] = [];
    let snapshot = createEmptySnapshot();

    const applyDataEvent = createDataEventHandler({
      getSnapshot: () => snapshot,
      setSnapshot: (nextSnapshot) => {
        snapshot = nextSnapshot;
      },
      pruneSnapshot: (nextSnapshot) => nextSnapshot,
      emit: (event) => emittedEvents.push(event.type),
      refreshHistory: async () => {},
      refreshDeviceHistory: async () => {},
      refreshSyncStateOnly: async () => {},
      markAnalyticsSyncInProgress: () => {},
      markAnalyticsSyncComplete: () => {},
      markAnalyticsSyncFailure: () => {},
      refreshAnalyticsNow: (deviceId) => refreshAnalyticsNowCalls.push(deviceId),
      scheduleAnalyticsRefresh: (deviceId) => scheduleAnalyticsRefreshCalls.push(deviceId),
      recordLiveMotion: (event) => {
        if (event) {
          recordLiveMotionCalls.push(event.deviceId);
        }
      },
      reportHistoryRefreshFailure: () => {},
      clearHistoryRefreshFailure: () => {},
    });

    applyDataEvent({
      type: "motion-update",
      payload: {
        device: createRepositoryDevice("stack-001"),
        event: {
          id: 11,
          deviceId: "stack-001",
          sequence: 7,
          state: "moving",
          delta: 4,
          eventTimestamp: 1234,
          receivedAt: "2026-03-18T12:00:01.000Z",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
        },
      },
    });

    expect(refreshAnalyticsNowCalls).toEqual(["stack-001"]);
    expect(scheduleAnalyticsRefreshCalls).toEqual([]);
    expect(recordLiveMotionCalls).toEqual(["stack-001"]);
    expect(emittedEvents).toEqual(["runtime-batch"]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.activities).toHaveLength(1);
  });

  it("removes optimistic live records from the renderer batch before adding canonical records", () => {
    const emittedEvents: Array<ReturnType<typeof createEmptySnapshot> | { type: string; patch?: unknown }> = [];
    let snapshot = createEmptySnapshot();

    const applyDataEvent = createDataEventHandler({
      getSnapshot: () => snapshot,
      setSnapshot: (nextSnapshot) => {
        snapshot = nextSnapshot;
      },
      pruneSnapshot: (nextSnapshot) => nextSnapshot,
      clearOptimisticMessage: () => ({
        removedEventIds: [-1],
        removedLogIds: [],
        removedActivityIds: ["optimistic-motion:message-1"],
      }),
      emit: (event) => emittedEvents.push(event),
      refreshHistory: async () => {},
      refreshDeviceHistory: async () => {},
      refreshSyncStateOnly: async () => {},
      markAnalyticsSyncInProgress: () => {},
      markAnalyticsSyncComplete: () => {},
      markAnalyticsSyncFailure: () => {},
      refreshAnalyticsNow: () => {},
      scheduleAnalyticsRefresh: () => {},
      recordLiveMotion: () => {},
      reportHistoryRefreshFailure: () => {},
      clearHistoryRefreshFailure: () => {},
    });

    applyDataEvent({
      type: "motion-update",
      sourceMessageId: "message-1",
      payload: {
        device: createRepositoryDevice("stack-001"),
        event: {
          id: 11,
          deviceId: "stack-001",
          sequence: 7,
          state: "moving",
          delta: 4,
          eventTimestamp: 1234,
          receivedAt: "2026-03-18T12:00:01.000Z",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
        },
      },
    });

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      type: "runtime-batch",
      patch: {
        removedEventIds: [-1],
        removedActivityIds: ["optimistic-motion:message-1"],
        events: [
          expect.objectContaining({
            id: 11,
            deviceId: "stack-001",
            state: "moving",
          }),
        ],
      },
    });
  });

  it("keeps backfill on the background analytics refresh path", async () => {
    const refreshAnalyticsNowCalls: string[] = [];
    const scheduleAnalyticsRefreshCalls: string[] = [];
    const markedSyncStates: string[] = [];
    const emittedEvents: string[] = [];
    const refreshedDevices: string[] = [];
    const callOrder: string[] = [];
    let snapshot = createEmptySnapshot();

    const applyDataEvent = createDataEventHandler({
      getSnapshot: () => snapshot,
      setSnapshot: (nextSnapshot) => {
        snapshot = nextSnapshot;
      },
      pruneSnapshot: (nextSnapshot) => nextSnapshot,
      emit: (event) => emittedEvents.push(event.type),
      refreshHistory: async () => {
        throw new Error("should not refresh full history");
      },
      refreshDeviceHistory: async (deviceId) => {
        refreshedDevices.push(deviceId);
        callOrder.push(`history:${deviceId}`);
      },
      refreshSyncStateOnly: async () => {
        throw new Error("should not refresh sync-only state on final page");
      },
      markAnalyticsSyncInProgress: (deviceId) => {
        markedSyncStates.push(`syncing:${deviceId}`);
      },
      markAnalyticsSyncComplete: (deviceId) => {
        markedSyncStates.push(`complete:${deviceId}`);
      },
      markAnalyticsSyncFailure: (deviceId, detail) => {
        markedSyncStates.push(`failed:${deviceId}:${detail}`);
      },
      refreshAnalyticsNow: (deviceId) => refreshAnalyticsNowCalls.push(deviceId),
      scheduleAnalyticsRefresh: (deviceId) => {
        scheduleAnalyticsRefreshCalls.push(deviceId);
        callOrder.push(`analytics:${deviceId}`);
      },
      recordLiveMotion: () => {},
      reportHistoryRefreshFailure: () => {},
      clearHistoryRefreshFailure: () => {},
    });

    applyDataEvent({
      type: "backfill-recorded",
      payload: {},
      deviceId: "stack-001",
      syncComplete: true,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(refreshAnalyticsNowCalls).toEqual([]);
    expect(scheduleAnalyticsRefreshCalls).toEqual(["stack-001"]);
    expect(refreshedDevices).toEqual(["stack-001"]);
    expect(markedSyncStates).toEqual(["complete:stack-001"]);
    expect(callOrder).toEqual(["history:stack-001", "analytics:stack-001"]);
    expect(emittedEvents).toContain("snapshot");
  });
});
