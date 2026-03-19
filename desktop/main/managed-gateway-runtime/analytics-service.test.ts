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
    const onUpdated = vi.fn();
    const service = createAnalyticsService({
      store: createStore(),
      getRuntimeDevice: () => null,
      onUpdated,
      listMotionRollupBuckets: async () => [
        {
          deviceId: "stack-001",
          bucketStart: Date.parse("2026-03-18T12:00:00.000Z"),
          movementCount: 1,
          movingSeconds: 900,
          updatedAt: "2026-03-18T12:30:00.000Z",
        },
      ],
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
    expect(onUpdated).not.toHaveBeenCalled();
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
      listMotionRollupBuckets: async () => [],
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
});
