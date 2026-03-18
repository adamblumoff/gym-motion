import {
  findLatestDeviceMotionEventBeforeReceivedAt,
  getDeviceSyncState,
  listDeviceMotionEventsByReceivedAt,
} from "../../../backend/data";
import type { PreferencesStore } from "../preferences-store";
import type {
  AnalyticsWindow,
  DeviceAnalyticsBucket,
  DeviceAnalyticsSnapshot,
  DeviceAnalyticsSyncState,
  GatewayRuntimeDeviceSummary,
  GetDeviceAnalyticsInput,
  MotionEventSummary,
} from "@core/contracts";

const ANALYTICS_CACHE_KEY = "gym-motion.desktop.analytics-cache.v1";

type CachedAnalyticsMap = Record<string, DeviceAnalyticsSnapshot>;

type AnalyticsServiceDeps = {
  store: PreferencesStore;
  getRuntimeDevice: (deviceId: string) => GatewayRuntimeDeviceSummary | null;
  onUpdated: (analytics: DeviceAnalyticsSnapshot) => void;
};

type WindowDefinition = {
  window: AnalyticsWindow;
  bucketMs: number;
  bucketCount: number;
  labelFormatter: (timestamp: number) => string;
};

const WINDOW_DEFINITIONS: Record<AnalyticsWindow, WindowDefinition> = {
  "24h": {
    window: "24h",
    bucketMs: 60 * 60 * 1000,
    bucketCount: 24,
    labelFormatter: (timestamp) =>
      new Date(timestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
      }),
  },
  "7d": {
    window: "7d",
    bucketMs: 24 * 60 * 60 * 1000,
    bucketCount: 7,
    labelFormatter: (timestamp) =>
      new Date(timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
  },
};

function cacheKey(deviceId: string, window: AnalyticsWindow) {
  return `${deviceId}::${window}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function createBuckets(definition: WindowDefinition, endTimestamp: number) {
  const end = Math.ceil(endTimestamp / definition.bucketMs) * definition.bucketMs;
  const start = end - definition.bucketCount * definition.bucketMs;
  const buckets: DeviceAnalyticsBucket[] = [];

  for (let index = 0; index < definition.bucketCount; index += 1) {
    const bucketStart = start + index * definition.bucketMs;
    const bucketEnd = bucketStart + definition.bucketMs;
    buckets.push({
      key: `${definition.window}-${bucketStart}`,
      label: definition.labelFormatter(bucketStart),
      startAt: new Date(bucketStart).toISOString(),
      endAt: new Date(bucketEnd).toISOString(),
      movementCount: 0,
      movingSeconds: 0,
    });
  }

  return {
    start,
    end,
    buckets,
  };
}

function addMovingDuration(
  buckets: DeviceAnalyticsBucket[],
  bucketMs: number,
  windowStart: number,
  windowEnd: number,
  startTimestamp: number,
  endTimestamp: number,
) {
  const clampedStart = clamp(startTimestamp, windowStart, windowEnd);
  const clampedEnd = clamp(endTimestamp, windowStart, windowEnd);

  if (clampedEnd <= clampedStart) {
    return;
  }

  let cursor = clampedStart;
  while (cursor < clampedEnd) {
    const bucketIndex = Math.max(0, Math.floor((cursor - windowStart) / bucketMs));
    const bucket = buckets[bucketIndex];

    if (!bucket) {
      break;
    }

    const bucketEnd = windowStart + (bucketIndex + 1) * bucketMs;
    const segmentEnd = Math.min(bucketEnd, clampedEnd);
    bucket.movingSeconds += (segmentEnd - cursor) / 1000;
    cursor = segmentEnd;
  }
}

function countMovementStart(
  buckets: DeviceAnalyticsBucket[],
  bucketMs: number,
  windowStart: number,
  timestamp: number,
) {
  const bucketIndex = Math.floor((timestamp - windowStart) / bucketMs);
  const bucket = buckets[bucketIndex];

  if (bucket) {
    bucket.movementCount += 1;
  }
}

function eventTimelineTimestamp(event: MotionEventSummary) {
  return Date.parse(event.receivedAt);
}

function baseWarningFlags(
  warningFlags: DeviceAnalyticsSnapshot["warningFlags"],
) {
  return warningFlags.filter(
    (warningFlag) =>
      warningFlag !== "sync-delayed" &&
      warningFlag !== "sync-failed" &&
      warningFlag !== "stale-cache",
  );
}

function hydrateSyncState(
  deviceId: string,
  runtimeDevice: GatewayRuntimeDeviceSummary | null,
  lastCanonicalAt: string | null,
  syncSummary: Awaited<ReturnType<typeof getDeviceSyncState>>,
  failureDetail: string | null,
): DeviceAnalyticsSyncState {
  const lastConnectedAt =
    runtimeDevice?.gatewayLastConnectedAt ??
    runtimeDevice?.gatewayLastTelemetryAt ??
    runtimeDevice?.updatedAt ??
    null;
  const lastSyncCompletedAt = syncSummary.lastSyncCompletedAt;
  const shouldSync =
    runtimeDevice?.gatewayConnectionState === "connected" &&
    !!lastConnectedAt &&
    !!lastSyncCompletedAt &&
    Date.parse(lastSyncCompletedAt) < Date.parse(lastConnectedAt);

  return {
    deviceId,
    state: failureDetail ? "failed" : shouldSync ? "syncing" : "idle",
    detail: failureDetail,
    lastCanonicalAt,
    lastSyncCompletedAt,
    lastAckedSequence: syncSummary.lastAckedSequence,
    lastAckedBootId: syncSummary.lastAckedBootId,
    lastOverflowDetectedAt: syncSummary.lastOverflowDetectedAt,
  };
}

async function buildAnalyticsSnapshot(args: {
  deviceId: string;
  window: AnalyticsWindow;
  runtimeDevice: GatewayRuntimeDeviceSummary | null;
  failureDetail: string | null;
}): Promise<DeviceAnalyticsSnapshot> {
  const definition = WINDOW_DEFINITIONS[args.window];
  const { start, end, buckets } = createBuckets(definition, Date.now());
  const windowStartAt = new Date(start).toISOString();
  const windowEndAt = new Date(end).toISOString();
  const [events, precedingEvent, syncSummary] = await Promise.all([
    listDeviceMotionEventsByReceivedAt({
      deviceId: args.deviceId,
      startReceivedAt: windowStartAt,
      endReceivedAt: windowEndAt,
    }),
    findLatestDeviceMotionEventBeforeReceivedAt({
      deviceId: args.deviceId,
      beforeReceivedAt: windowStartAt,
    }),
    getDeviceSyncState(args.deviceId),
  ]);

  let currentState = precedingEvent?.state ?? "still";
  let currentSegmentStart = start;

  for (const event of events) {
    const timelineTimestamp = eventTimelineTimestamp(event);

    if (!Number.isFinite(timelineTimestamp)) {
      continue;
    }

    if (currentState === "moving") {
      addMovingDuration(
        buckets,
        definition.bucketMs,
        start,
        end,
        currentSegmentStart,
        timelineTimestamp,
      );
    }

    if (event.state === "moving") {
      countMovementStart(buckets, definition.bucketMs, start, timelineTimestamp);
    }

    currentState = event.state;
    currentSegmentStart = timelineTimestamp;
  }

  if (currentState === "moving") {
    addMovingDuration(
      buckets,
      definition.bucketMs,
      start,
      end,
      currentSegmentStart,
      end,
    );
  }

  const generatedAt = new Date().toISOString();
  const sync = hydrateSyncState(
    args.deviceId,
    args.runtimeDevice,
    generatedAt,
    syncSummary,
    args.failureDetail,
  );
  const warningFlags = new Set<DeviceAnalyticsSnapshot["warningFlags"][number]>();

  if (sync.lastOverflowDetectedAt) {
    warningFlags.add("history-overflow");
  }
  if (sync.state === "syncing") {
    warningFlags.add("sync-delayed");
  }
  if (sync.state === "failed") {
    warningFlags.add("sync-failed");
  }

  return {
    deviceId: args.deviceId,
    window: args.window,
    generatedAt,
    source: "canonical",
    buckets,
    totalMovementCount: buckets.reduce((sum, bucket) => sum + bucket.movementCount, 0),
    totalMovingSeconds: Math.round(
      buckets.reduce((sum, bucket) => sum + bucket.movingSeconds, 0),
    ),
    warningFlags: [...warningFlags],
    sync,
  };
}

export type AnalyticsService = {
  getDeviceAnalytics: (input: GetDeviceAnalyticsInput) => Promise<DeviceAnalyticsSnapshot>;
  scheduleRefresh: (deviceId: string) => void;
  markSyncFailure: (deviceId: string, detail: string) => void;
  clearSyncFailure: (deviceId: string) => void;
};

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const syncFailures = new Map<string, string>();

  function readCache(): CachedAnalyticsMap {
    return deps.store.getJson<CachedAnalyticsMap>(ANALYTICS_CACHE_KEY) ?? {};
  }

  function writeCache(cache: CachedAnalyticsMap) {
    deps.store.setJson(ANALYTICS_CACHE_KEY, cache);
  }

  async function emitCachedSnapshots(deviceId: string) {
    const cache = readCache();

    for (const window of Object.keys(WINDOW_DEFINITIONS) as AnalyticsWindow[]) {
      const cached = cache[cacheKey(deviceId, window)];
      if (!cached) {
        continue;
      }

      const syncSummary = await getDeviceSyncState(deviceId);
      const sync = hydrateSyncState(
        deviceId,
        deps.getRuntimeDevice(deviceId),
        cached.generatedAt,
        syncSummary,
        syncFailures.get(deviceId) ?? null,
      );
      const warningFlags = new Set<DeviceAnalyticsSnapshot["warningFlags"][number]>(
        baseWarningFlags(cached.warningFlags),
      );

      if (sync.state === "syncing") {
        warningFlags.add("sync-delayed");
      }
      if (sync.state === "failed") {
        warningFlags.add("sync-failed");
        warningFlags.add("stale-cache");
      }
      if (sync.lastOverflowDetectedAt) {
        warningFlags.add("history-overflow");
      }

      deps.onUpdated({
        ...cached,
        source: sync.state === "idle" ? "canonical" : "cache",
        sync,
        warningFlags: [...warningFlags],
      });
    }
  }

  async function refreshDevice(deviceId: string) {
    const runtimeDevice = deps.getRuntimeDevice(deviceId);
    const failureDetail = syncFailures.get(deviceId) ?? null;
    const nextCache = {
      ...readCache(),
    };

    for (const window of Object.keys(WINDOW_DEFINITIONS) as AnalyticsWindow[]) {
      const analytics = await buildAnalyticsSnapshot({
        deviceId,
        window,
        runtimeDevice,
        failureDetail,
      });
      nextCache[cacheKey(deviceId, window)] = analytics;
      deps.onUpdated(analytics);
    }

    writeCache(nextCache);
  }

  function scheduleRefresh(deviceId: string) {
    const existing = refreshTimers.get(deviceId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      refreshTimers.delete(deviceId);
      void refreshDevice(deviceId).catch((error) => {
        const detail = error instanceof Error ? error.message : "Analytics refresh failed.";
        syncFailures.set(deviceId, detail);
        void emitCachedSnapshots(deviceId);
      });
    }, 150);
    timer.unref?.();
    refreshTimers.set(deviceId, timer);
  }

  return {
    async getDeviceAnalytics(input) {
      const cache = readCache();
      const cached = cache[cacheKey(input.deviceId, input.window)];

      if (cached) {
        scheduleRefresh(input.deviceId);
        const syncSummary = await getDeviceSyncState(input.deviceId);
        const sync = hydrateSyncState(
          input.deviceId,
          deps.getRuntimeDevice(input.deviceId),
          cached.generatedAt,
          syncSummary,
          syncFailures.get(input.deviceId) ?? null,
        );
        const warningFlags = new Set<DeviceAnalyticsSnapshot["warningFlags"][number]>(
          baseWarningFlags(cached.warningFlags),
        );

        if (sync.state === "syncing") {
          warningFlags.add("sync-delayed");
          warningFlags.add("stale-cache");
        }
        if (sync.state === "failed") {
          warningFlags.add("sync-failed");
          warningFlags.add("stale-cache");
        }
        if (sync.lastOverflowDetectedAt) {
          warningFlags.add("history-overflow");
        }

        return {
          ...cached,
          source: sync.state === "idle" ? "canonical" : "cache",
          sync,
          warningFlags: [...warningFlags],
        };
      }

      const analytics = await buildAnalyticsSnapshot({
        deviceId: input.deviceId,
        window: input.window,
        runtimeDevice: deps.getRuntimeDevice(input.deviceId),
        failureDetail: syncFailures.get(input.deviceId) ?? null,
      });

      writeCache({
        ...cache,
        [cacheKey(input.deviceId, input.window)]: analytics,
      });

      return analytics;
    },

    scheduleRefresh,

    markSyncFailure(deviceId, detail) {
      syncFailures.set(deviceId, detail);
      void emitCachedSnapshots(deviceId);
    },

    clearSyncFailure(deviceId) {
      if (!syncFailures.delete(deviceId)) {
        return;
      }

      scheduleRefresh(deviceId);
    },
  };
}
