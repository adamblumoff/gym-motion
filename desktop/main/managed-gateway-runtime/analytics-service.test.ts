import { describe, expect, it, vi } from "vitest";

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

  it("falls back to raw motion events when rollups are unavailable", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T12:30:00.000Z"));
    const listDeviceMotionEventsByReceivedAt = vi.fn(async () => [
      {
        id: 1,
        deviceId: "stack-001",
        sequence: null,
        state: "moving" as const,
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
        sequence: null,
        state: "still" as const,
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
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.totalMovementCount).toBe(1);
    expect(analytics.totalMovingSeconds).toBe(15 * 60);
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
          sequence: null,
          state: "moving" as const,
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
          sequence: null,
          state: "still" as const,
          delta: 0,
          eventTimestamp: 40_809_018,
          receivedAt: "2026-03-19T15:52:40.409Z",
          bootId: "boot-1",
          firmwareVersion: "1.0.0",
          hardwareId: "hw-1",
        },
      ],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
    });

    const analytics = await service.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });

    expect(analytics.totalMovementCount).toBe(1);
    expect(analytics.totalMovingSeconds).toBeGreaterThan(0);
    nowSpy.mockRestore();
  });

  it("overlays live motion on top of cached canonical analytics immediately", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-18T12:45:00.000Z"));
    const cachedSnapshot = {
      deviceId: "stack-001",
      window: "24h" as const,
      generatedAt: "2026-03-18T12:30:00.000Z",
      source: "canonical" as const,
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
    };
    const onUpdated = vi.fn();
    const service = createAnalyticsService({
      store: createStore({
        "gym-motion.desktop.analytics-cache.v2": {
          "stack-001::24h": cachedSnapshot,
        },
      }),
      getRuntimeDevice: () => null,
      onUpdated,
      hasMotionRollupTables: async () => true,
      listMotionRollupBuckets: async () => [],
      listDeviceMotionEventsByReceivedAt: async () => [],
      findLatestDeviceMotionEventBeforeReceivedAt: async () => null,
    });

    service.recordLiveMotion({
      id: 11,
      deviceId: "stack-001",
      sequence: null,
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
});
