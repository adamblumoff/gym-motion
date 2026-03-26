import { describe, expect, it, vi } from "vitest";

import type { DeviceAnalyticsSnapshot } from "@core/contracts";

import { createAnalyticsService } from "./analytics-service";

function createStore(initial: Record<string, unknown> = {}) {
  const state = { ...initial };

  return {
    getJson<T>(key: string) {
      return state[key] as T | undefined;
    },
    setJson(key: string, value: unknown) {
      state[key] = value;
    },
  };
}

describe("createAnalyticsService", () => {
  it("builds canonical snapshots from rollup buckets", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T12:30:00.000Z"));
    const onUpdated = vi.fn();
    const listMotionRollupBuckets = vi.fn(async () => [
      {
        deviceId: "stack-001",
        bucketStart: Date.parse("2026-03-18T12:00:00.000Z"),
        movementCount: 1,
        movingSeconds: 900,
        updatedAt: "2026-03-18T12:30:00.000Z",
      },
    ]);
    const service = createAnalyticsService({
      store: createStore(),
      getRuntimeDevice: () => null,
      onUpdated,
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets,
      listDeviceMotionEventsByReceivedAt: vi.fn(async () => []),
      findLatestDeviceMotionEventBeforeReceivedAt: vi.fn(async () => null),
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.source).toBe("canonical");
    expect(analytics.totalMovementCount).toBe(1);
    expect(analytics.totalMovingSeconds).toBe(900);
    expect(analytics.buckets.some((bucket) => bucket.movementCount === 1)).toBe(true);
    expect(listMotionRollupBuckets).toHaveBeenCalledOnce();
    expect(onUpdated).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("returns cached snapshots while preserving sync warning derivation", async () => {
    const cachedSnapshot: DeviceAnalyticsSnapshot = {
      deviceId: "stack-001",
      window: "24h",
      generatedAt: "2026-03-18T12:30:00.000Z",
      source: "canonical",
      buckets: [
        {
          key: "24h-0",
          label: "12",
          startAt: "2026-03-18T12:00:00.000Z",
          endAt: "2026-03-18T13:00:00.000Z",
          movementCount: 1,
          movingSeconds: 900,
        },
      ],
      totalMovementCount: 1,
      totalMovingSeconds: 900,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: "2026-03-18T12:30:00.000Z",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    };

    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v1": {
          "stack-001::24h": cachedSnapshot,
        },
      }),
      getRuntimeDevice: () => ({
        id: "stack-001",
        lastState: "still",
        lastSeenAt: 1,
        lastDelta: null,
        updatedAt: "2026-03-18T13:00:00.000Z",
        hardwareId: null,
        bootId: null,
        firmwareVersion: "1.0.0",
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
        peripheralId: null,
        address: null,
        gatewayLastAdvertisementAt: null,
        gatewayLastConnectedAt: "2026-03-18T13:00:00.000Z",
        gatewayLastDisconnectedAt: null,
        gatewayLastTelemetryAt: "2026-03-18T13:00:00.000Z",
        gatewayDisconnectReason: null,
        advertisedName: null,
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
        reconnectAttemptLimit: 3,
        reconnectRetryExhausted: false,
      }),
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets: async () => [],
      listDeviceMotionEventsByReceivedAt: async () => [],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.source).toBe("cache");
    expect(analytics.warningFlags).toContain("sync-delayed");
    expect(analytics.warningFlags).toContain("stale-cache");
  });

  it("honors explicit runtime sync completion over the stale timestamp heuristic", async () => {
    const cachedSnapshot: DeviceAnalyticsSnapshot = {
      deviceId: "stack-001",
      window: "24h",
      generatedAt: "2026-03-18T12:30:00.000Z",
      source: "canonical",
      buckets: [
        {
          key: "24h-0",
          label: "12",
          startAt: "2026-03-18T12:00:00.000Z",
          endAt: "2026-03-18T13:00:00.000Z",
          movementCount: 1,
          movingSeconds: 900,
        },
      ],
      totalMovementCount: 1,
      totalMovingSeconds: 900,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: "2026-03-18T12:30:00.000Z",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    };

    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v1": {
          "stack-001::24h": cachedSnapshot,
        },
      }),
      getRuntimeDevice: () => ({
        id: "stack-001",
        lastState: "still",
        lastSeenAt: 1,
        lastDelta: null,
        updatedAt: "2026-03-18T13:00:00.000Z",
        hardwareId: null,
        bootId: null,
        firmwareVersion: "1.0.0",
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
        peripheralId: null,
        address: null,
        gatewayLastAdvertisementAt: null,
        gatewayLastConnectedAt: "2026-03-18T13:00:00.000Z",
        gatewayLastDisconnectedAt: null,
        gatewayLastTelemetryAt: "2026-03-18T13:00:00.000Z",
        gatewayDisconnectReason: null,
        advertisedName: null,
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
        reconnectAttemptLimit: 3,
        reconnectRetryExhausted: false,
      }),
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets: async () => [],
      listDeviceMotionEventsByReceivedAt: async () => [],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    service.markSyncComplete("stack-001");

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.sync.state).toBe("idle");
    expect(analytics.warningFlags).not.toContain("sync-delayed");
  });

  it("honors explicit runtime sync progress before canonical refresh catches up", async () => {
    const cachedSnapshot: DeviceAnalyticsSnapshot = {
      deviceId: "stack-001",
      window: "24h",
      generatedAt: "2026-03-18T12:30:00.000Z",
      source: "canonical",
      buckets: [
        {
          key: "24h-0",
          label: "12",
          startAt: "2026-03-18T12:00:00.000Z",
          endAt: "2026-03-18T13:00:00.000Z",
          movementCount: 1,
          movingSeconds: 900,
        },
      ],
      totalMovementCount: 1,
      totalMovingSeconds: 900,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: "2026-03-18T12:30:00.000Z",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    };

    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v1": {
          "stack-001::24h": cachedSnapshot,
        },
      }),
      getRuntimeDevice: () => null,
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets: async () => [],
      listDeviceMotionEventsByReceivedAt: async () => [],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    service.markSyncInProgress("stack-001");

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.sync.state).toBe("syncing");
    expect(analytics.warningFlags).toContain("sync-delayed");
  });

  it("falls back to raw history when rollup tables are unavailable", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T12:30:00.000Z"));
    const listDeviceMotionEventsByReceivedAt = vi.fn(async () => [
      {
        id: 1,
        deviceId: "stack-001",
        sequence: 1,
        state: "moving",
        delta: 3,
        eventTimestamp: Date.parse("2026-03-18T12:10:00.000Z"),
        receivedAt: "2026-03-18T12:10:00.000Z",
        bootId: "boot-1",
        firmwareVersion: "1.0.0",
        hardwareId: "hw-1",
      },
      {
        id: 2,
        deviceId: "stack-001",
        sequence: 2,
        state: "still",
        delta: 0,
        eventTimestamp: Date.parse("2026-03-18T12:25:00.000Z"),
        receivedAt: "2026-03-18T12:25:00.000Z",
        bootId: "boot-1",
        firmwareVersion: "1.0.0",
        hardwareId: "hw-1",
      },
    ]);
    const service = createAnalyticsService({
      store: createStore(),
      getRuntimeDevice: () => null,
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => false,
      listMotionRollupBuckets: vi.fn(async () => []),
      listDeviceMotionEventsByReceivedAt,
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 2,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.totalMovementCount).toBe(1);
    expect(analytics.totalMovingSeconds).toBe(15 * 60);
    expect(analytics.buckets.some((bucket) => bucket.movingSeconds === 15 * 60)).toBe(true);
    expect(listDeviceMotionEventsByReceivedAt).toHaveBeenCalledOnce();
    nowSpy.mockRestore();
  });

  it("uses received time windows even when event timestamps are boot-relative", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-19T16:00:00.000Z"));
    const service = createAnalyticsService({
      store: createStore(),
      getRuntimeDevice: () => null,
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => false,
      listMotionRollupBuckets: async () => [],
      listDeviceMotionEventsByReceivedAt: async () => [
        {
          id: 1,
          deviceId: "stack-001",
          sequence: 1448,
          state: "moving",
          delta: 3,
          eventTimestamp: 40_750_267,
          receivedAt: "2026-03-19T15:51:41.666Z",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
        },
        {
          id: 2,
          deviceId: "stack-001",
          sequence: 1449,
          state: "still",
          delta: 0,
          eventTimestamp: 40_809_018,
          receivedAt: "2026-03-19T15:52:40.409Z",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
        },
      ],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 1449,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-19T15:52:41.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.totalMovementCount).toBe(1);
    expect(analytics.totalMovingSeconds).toBeGreaterThan(0);
    nowSpy.mockRestore();
  });

  it("returns stale cached analytics when sync state lookup fails", async () => {
    const cachedSnapshot: DeviceAnalyticsSnapshot = {
      deviceId: "stack-001",
      window: "24h",
      generatedAt: "2026-03-18T12:30:00.000Z",
      source: "canonical",
      buckets: [
        {
          key: "24h-0",
          label: "12",
          startAt: "2026-03-18T12:00:00.000Z",
          endAt: "2026-03-18T13:00:00.000Z",
          movementCount: 1,
          movingSeconds: 900,
        },
      ],
      totalMovementCount: 1,
      totalMovingSeconds: 900,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: "2026-03-18T12:30:00.000Z",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v1": {
          "stack-001::24h": cachedSnapshot,
        },
      }),
      getRuntimeDevice: () => null,
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets: async () => [],
      getDeviceSyncState: async () => {
        throw new Error("Connection terminated unexpectedly");
      },
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.source).toBe("cache");
    expect(analytics.warningFlags).toContain("sync-failed");
    expect(analytics.warningFlags).toContain("stale-cache");
    expect(analytics.sync.state).toBe("failed");
    expect(analytics.sync.detail).toContain("Connection terminated unexpectedly");
    expect(errorSpy).toHaveBeenCalledWith(
      "[runtime] failed to load cached analytics sync state",
      expect.any(Error),
    );
  });

  it("prefers raw history over empty rollups while catch-up is still syncing", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T13:00:00.000Z"));
    const listDeviceMotionEventsByReceivedAt = vi.fn(async () => [
      {
        id: 1,
        deviceId: "stack-001",
        sequence: 11,
        state: "moving",
        delta: 3,
        eventTimestamp: Date.parse("2026-03-18T12:31:00.000Z"),
        receivedAt: "2026-03-18T12:31:00.000Z",
        bootId: "boot-1",
        firmwareVersion: "1.0.0",
        hardwareId: "hw-1",
      },
      {
        id: 2,
        deviceId: "stack-001",
        sequence: 12,
        state: "still",
        delta: 0,
        eventTimestamp: Date.parse("2026-03-18T12:45:00.000Z"),
        receivedAt: "2026-03-18T12:45:00.000Z",
        bootId: "boot-1",
        firmwareVersion: "1.0.0",
        hardwareId: "hw-1",
      },
    ]);
    const listMotionRollupBuckets = vi.fn(async () => []);
    const service = createAnalyticsService({
      store: createStore(),
      getRuntimeDevice: () => ({
        id: "stack-001",
        lastState: "still",
        lastSeenAt: 1,
        lastDelta: null,
        updatedAt: "2026-03-18T13:00:00.000Z",
        hardwareId: null,
        bootId: "boot-1",
        firmwareVersion: "1.0.0",
        machineLabel: null,
        siteId: null,
        provisioningState: "provisioned",
        updateStatus: "idle",
        updateTargetVersion: null,
        updateDetail: null,
        updateUpdatedAt: null,
        lastHeartbeatAt: null,
        lastEventReceivedAt: "2026-03-18T13:00:00.000Z",
        healthStatus: "online",
        gatewayConnectionState: "connected",
        telemetryFreshness: "fresh",
        peripheralId: null,
        address: null,
        gatewayLastAdvertisementAt: null,
        gatewayLastConnectedAt: "2026-03-18T13:00:00.000Z",
        gatewayLastDisconnectedAt: null,
        gatewayLastTelemetryAt: "2026-03-18T13:00:00.000Z",
        gatewayDisconnectReason: null,
        advertisedName: null,
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
        reconnectAttemptLimit: 3,
        reconnectRetryExhausted: false,
      }),
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets,
      listDeviceMotionEventsByReceivedAt,
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.totalMovementCount).toBe(1);
    expect(analytics.totalMovingSeconds).toBe(14 * 60);
    expect(analytics.sync.state).toBe("syncing");
    expect(listMotionRollupBuckets).not.toHaveBeenCalled();
    expect(listDeviceMotionEventsByReceivedAt).toHaveBeenCalledOnce();
    nowSpy.mockRestore();
  });

  it("ignores malformed cached analytics snapshots and rebuilds canonical analytics", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T12:30:00.000Z"));
    const listMotionRollupBuckets = vi.fn(async () => [
      {
        deviceId: "stack-001",
        bucketStart: Date.parse("2026-03-18T12:00:00.000Z"),
        movementCount: 2,
        movingSeconds: 1200,
        updatedAt: "2026-03-18T12:30:00.000Z",
      },
    ]);

    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v1": {
          "stack-001::24h": {
            deviceId: "stack-001",
            generatedAt: "2026-03-18T12:00:00.000Z",
            buckets: [],
          },
        },
      }),
      getRuntimeDevice: () => null,
      onUpdated: vi.fn(),
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets,
      listDeviceMotionEventsByReceivedAt: async () => [],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.source).toBe("canonical");
    expect(analytics.window).toBe("24h");
    expect(analytics.totalMovementCount).toBe(2);
    expect(analytics.totalMovingSeconds).toBe(1200);
    expect(listMotionRollupBuckets).toHaveBeenCalledOnce();
    nowSpy.mockRestore();
  });

  it("emits stale cached analytics instead of rejecting when background sync state lookup fails", async () => {
    const cachedSnapshot: DeviceAnalyticsSnapshot = {
      deviceId: "stack-001",
      window: "24h",
      generatedAt: "2026-03-18T12:30:00.000Z",
      source: "canonical",
      buckets: [
        {
          key: "24h-0",
          label: "12",
          startAt: "2026-03-18T12:00:00.000Z",
          endAt: "2026-03-18T13:00:00.000Z",
          movementCount: 1,
          movingSeconds: 900,
        },
      ],
      totalMovementCount: 1,
      totalMovingSeconds: 900,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: "2026-03-18T12:30:00.000Z",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    };
    const onUpdated = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v1": {
          "stack-001::24h": cachedSnapshot,
        },
      }),
      getRuntimeDevice: () => null,
      onUpdated,
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets: async () => [],
      getDeviceSyncState: async () => {
        throw new Error("Connection terminated unexpectedly");
      },
    });

    service.markSyncFailure("stack-001", "db unavailable");

    await Promise.resolve();
    await Promise.resolve();

    expect(onUpdated).toHaveBeenCalledTimes(1);

    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "cache",
        warningFlags: expect.arrayContaining(["sync-failed", "stale-cache"]),
        sync: expect.objectContaining({
          state: "failed",
          detail: "db unavailable",
        }),
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[runtime] failed to refresh cached analytics sync state",
      expect.any(Error),
    );
  });

  it("overlays live motion on top of cached canonical analytics immediately", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T12:45:00.000Z"));
    const cachedSnapshot: DeviceAnalyticsSnapshot = {
      deviceId: "stack-001",
      window: "24h",
      generatedAt: "2026-03-18T12:30:00.000Z",
      source: "canonical",
      buckets: [
        {
          key: "24h-0",
          label: "12",
          startAt: "2026-03-18T12:00:00.000Z",
          endAt: "2026-03-18T13:00:00.000Z",
          movementCount: 1,
          movingSeconds: 900,
        },
      ],
      totalMovementCount: 1,
      totalMovingSeconds: 900,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: "2026-03-18T12:30:00.000Z",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    };
    const onUpdated = vi.fn();
    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v1": {
          "stack-001::24h": cachedSnapshot,
        },
      }),
      getRuntimeDevice: () => null,
      onUpdated,
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets: async () => [],
      listDeviceMotionEventsByReceivedAt: async () => [],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 10,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:30:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    service.recordLiveMotion({
      id: 11,
      deviceId: "stack-001",
      sequence: 11,
      state: "moving",
      delta: 7,
      eventTimestamp: Date.parse("2026-03-18T12:31:00.000Z"),
      receivedAt: "2026-03-18T12:31:00.000Z",
      bootId: "boot-1",
      firmwareVersion: "1.0.0",
      hardwareId: "hw-1",
    });

    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        totalMovementCount: 2,
        totalMovingSeconds: 900 + 14 * 60,
        liveOverlay: expect.objectContaining({
          active: true,
          totalMovementCount: 1,
          totalMovingSeconds: 14 * 60,
        }),
      }),
    );
    nowSpy.mockRestore();
  });

  it("clears live overlay once a newer canonical snapshot catches up", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T12:45:00.000Z"));
    vi.useFakeTimers();
    const onUpdated = vi.fn();
    const listMotionRollupBuckets = vi
      .fn()
      .mockResolvedValueOnce([
        {
          deviceId: "stack-001",
          bucketStart: Date.parse("2026-03-18T12:00:00.000Z"),
          movementCount: 1,
          movingSeconds: 900,
          updatedAt: "2026-03-18T12:30:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          deviceId: "stack-001",
          bucketStart: Date.parse("2026-03-18T12:00:00.000Z"),
          movementCount: 2,
          movingSeconds: 1740,
          updatedAt: "2026-03-18T12:45:00.000Z",
        },
      ]);
    const service = createAnalyticsService({
      store: createStore(),
      getRuntimeDevice: () => null,
      onUpdated,
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets,
      listDeviceMotionEventsByReceivedAt: async () => [],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
      getDeviceSyncState: async () => ({
        deviceId: "stack-001",
        lastAckedSequence: 11,
        lastAckedBootId: "boot-1",
        lastSyncCompletedAt: "2026-03-18T12:45:00.000Z",
        lastOverflowDetectedAt: null,
      }),
    });

    await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    service.recordLiveMotion({
      id: 11,
      deviceId: "stack-001",
      sequence: 11,
      state: "moving",
      delta: 7,
      eventTimestamp: Date.parse("2026-03-18T12:31:00.000Z"),
      receivedAt: "2026-03-18T12:31:00.000Z",
      bootId: "boot-1",
      firmwareVersion: "1.0.0",
      hardwareId: "hw-1",
    });

    onUpdated.mockClear();
    service.scheduleRefresh("stack-001", 0);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(onUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          totalMovementCount: 2,
          totalMovingSeconds: 1740,
          liveOverlay: expect.objectContaining({
            active: false,
          }),
        }),
      );
    });
    vi.useRealTimers();
    nowSpy.mockRestore();
  });
});
