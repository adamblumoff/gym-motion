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
  listDeviceMotionEventsByReceivedAt?: typeof listDeviceMotionEventsByReceivedAt;
  findLatestDeviceMotionEventBeforeReceivedAt?: typeof findLatestDeviceMotionEventBeforeReceivedAt;
  getDeviceSyncState?: typeof getDeviceSyncState;
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

export function summarizeMotionEventsInBuckets(args: {
  buckets: DeviceAnalyticsBucket[];
  bucketMs: number;
  windowStart: number;
  windowEnd: number;
  precedingState: MotionEventSummary["state"] | null;
  events: MotionEventSummary[];
}) {
  const {
    buckets,
    bucketMs,
    windowStart,
    windowEnd,
    precedingState,
    events,
  } = args;
  let currentState = precedingState ?? "still";
  let currentSegmentStart = windowStart;

  for (const event of events) {
    const timelineTimestamp = eventTimelineTimestamp(event);

    if (!Number.isFinite(timelineTimestamp)) {
      continue;
    }

    if (currentState === "moving") {
      addMovingDuration(
        buckets,
        bucketMs,
        windowStart,
        windowEnd,
        currentSegmentStart,
        timelineTimestamp,
      );
    }

    if (event.state === "moving") {
      countMovementStart(buckets, bucketMs, windowStart, timelineTimestamp);
    }

    currentState = event.state;
    currentSegmentStart = timelineTimestamp;
  }

  return {
    buckets,
    totalMovementCount: buckets.reduce((sum, bucket) => sum + bucket.movementCount, 0),
    totalMovingSeconds: Math.round(
      buckets.reduce((sum, bucket) => sum + bucket.movingSeconds, 0),
    ),
  };
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

function buildCachedSnapshotFromSync(
  cached: DeviceAnalyticsSnapshot,
  sync: DeviceAnalyticsSyncState,
  options?: { markStaleWhileSyncing?: boolean },
) {
  const warningFlags = new Set<DeviceAnalyticsSnapshot["warningFlags"][number]>(
    baseWarningFlags(cached.warningFlags),
  );

  if (sync.state === "syncing") {
    warningFlags.add("sync-delayed");
    if (options?.markStaleWhileSyncing) {
      warningFlags.add("stale-cache");
    }
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
  } satisfies DeviceAnalyticsSnapshot;
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

function buildFailedCachedSyncState(
  cached: DeviceAnalyticsSnapshot,
  detail: string,
): DeviceAnalyticsSyncState {
  return {
    ...cached.sync,
    state: "failed",
    detail,
    lastCanonicalAt: cached.generatedAt,
  };
}

async function buildAnalyticsSnapshot(args: {
  deviceId: string;
  window: AnalyticsWindow;
  runtimeDevice: GatewayRuntimeDeviceSummary | null;
  failureDetail: string | null;
  listDeviceMotionEventsByReceivedAt: typeof listDeviceMotionEventsByReceivedAt;
  findLatestDeviceMotionEventBeforeReceivedAt: typeof findLatestDeviceMotionEventBeforeReceivedAt;
  getDeviceSyncState: typeof getDeviceSyncState;
}): Promise<DeviceAnalyticsSnapshot> {
  const definition = WINDOW_DEFINITIONS[args.window];
  const { start, end, buckets } = createBuckets(definition, Date.now());
  const syncSummary = await args.getDeviceSyncState(
    args.deviceId,
    args.runtimeDevice?.bootId ?? null,
  );
  const windowStartAt = new Date(start).toISOString();
  const windowEndAt = new Date(end).toISOString();
  const [events, precedingEvent] = await Promise.all([
    args.listDeviceMotionEventsByReceivedAt({
      deviceId: args.deviceId,
      startReceivedAt: windowStartAt,
      endReceivedAt: windowEndAt,
    }),
    args.findLatestDeviceMotionEventBeforeReceivedAt({
      deviceId: args.deviceId,
      beforeReceivedAt: windowStartAt,
    }),
  ]);
  const summary = summarizeMotionEventsInBuckets({
    buckets,
    bucketMs: definition.bucketMs,
    windowStart: start,
    windowEnd: end,
    precedingState: precedingEvent?.state ?? null,
    events,
  });

  const totalMovementCount = summary.totalMovementCount;
  const totalMovingSeconds = summary.totalMovingSeconds;

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
    totalMovementCount,
    totalMovingSeconds,
    warningFlags: [...warningFlags],
    sync,
  };
}

export type AnalyticsService = {
  getDeviceAnalytics: (input: GetDeviceAnalyticsInput) => Promise<DeviceAnalyticsSnapshot>;
  scheduleRefresh: (deviceId: string, delayMs?: number) => void;
  markSyncFailure: (deviceId: string, detail: string) => void;
  clearSyncFailure: (deviceId: string) => void;
};

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const syncFailures = new Map<string, string>();
  const loadMotionEventsByReceivedAt =
    deps.listDeviceMotionEventsByReceivedAt ?? listDeviceMotionEventsByReceivedAt;
  const loadLatestMotionEventBeforeReceivedAt =
    deps.findLatestDeviceMotionEventBeforeReceivedAt ??
    findLatestDeviceMotionEventBeforeReceivedAt;
  const loadDeviceSyncState = deps.getDeviceSyncState ?? getDeviceSyncState;

  function readCache(): CachedAnalyticsMap {
    return deps.store.getJson<CachedAnalyticsMap>(ANALYTICS_CACHE_KEY) ?? {};
  }

  function writeCache(cache: CachedAnalyticsMap) {
    deps.store.setJson(ANALYTICS_CACHE_KEY, cache);
  }

  async function emitCachedSnapshots(deviceId: string) {
    const cache = readCache();
    const runtimeDevice = deps.getRuntimeDevice(deviceId);
    const failureDetail = syncFailures.get(deviceId) ?? null;
    let syncSummary: Awaited<ReturnType<typeof getDeviceSyncState>> | null = null;
    let cachedSyncErrorDetail: string | null = null;

    try {
      syncSummary = await loadDeviceSyncState(deviceId);
    } catch (error) {
      cachedSyncErrorDetail =
        failureDetail ??
        (error instanceof Error ? error.message : "Analytics sync state refresh failed.");
      console.error("[runtime] failed to refresh cached analytics sync state", error);
    }

    for (const window of Object.keys(WINDOW_DEFINITIONS) as AnalyticsWindow[]) {
      const cached = cache[cacheKey(deviceId, window)];
      if (!cached) {
        continue;
      }

      if (syncSummary) {
        const sync = hydrateSyncState(
          deviceId,
          runtimeDevice,
          cached.generatedAt,
          syncSummary,
          failureDetail,
        );
        deps.onUpdated(buildCachedSnapshotFromSync(cached, sync));
        continue;
      }

      deps.onUpdated(
        buildCachedSnapshotFromSync(
          cached,
          buildFailedCachedSyncState(
            cached,
            cachedSyncErrorDetail ?? "Analytics sync state refresh failed.",
          ),
        ),
      );
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
        listDeviceMotionEventsByReceivedAt: loadMotionEventsByReceivedAt,
        findLatestDeviceMotionEventBeforeReceivedAt:
          loadLatestMotionEventBeforeReceivedAt,
        getDeviceSyncState: loadDeviceSyncState,
      });
      nextCache[cacheKey(deviceId, window)] = analytics;
      deps.onUpdated(analytics);
    }

    writeCache(nextCache);
  }

  function scheduleRefresh(deviceId: string, delayMs = 150) {
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
    }, delayMs);
    timer.unref?.();
    refreshTimers.set(deviceId, timer);
  }

  return {
    async getDeviceAnalytics(input) {
      const cache = readCache();
      const cached = cache[cacheKey(input.deviceId, input.window)];

      if (cached) {
        scheduleRefresh(input.deviceId);
        try {
          const syncSummary = await loadDeviceSyncState(
            input.deviceId,
            deps.getRuntimeDevice(input.deviceId)?.bootId ?? null,
          );
          const sync = hydrateSyncState(
            input.deviceId,
            deps.getRuntimeDevice(input.deviceId),
            cached.generatedAt,
            syncSummary,
            syncFailures.get(input.deviceId) ?? null,
          );
          return buildCachedSnapshotFromSync(cached, sync, {
            markStaleWhileSyncing: true,
          });
        } catch (error) {
          const detail =
            syncFailures.get(input.deviceId) ??
            (error instanceof Error ? error.message : "Analytics sync state refresh failed.");
          console.error("[runtime] failed to load cached analytics sync state", error);
          return buildCachedSnapshotFromSync(
            cached,
            buildFailedCachedSyncState(cached, detail),
          );
        }
      }

      const analytics = await buildAnalyticsSnapshot({
        deviceId: input.deviceId,
        window: input.window,
        runtimeDevice: deps.getRuntimeDevice(input.deviceId),
        failureDetail: syncFailures.get(input.deviceId) ?? null,
        listDeviceMotionEventsByReceivedAt: loadMotionEventsByReceivedAt,
        findLatestDeviceMotionEventBeforeReceivedAt:
          loadLatestMotionEventBeforeReceivedAt,
        getDeviceSyncState: loadDeviceSyncState,
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
