import {
  getDeviceSyncState,
  listMotionRollupBuckets,
} from "../../../backend/data";
import type { PreferencesStore } from "../preferences-store";
import type {
  AnalyticsWindow,
  DeviceAnalyticsBucket,
  DeviceAnalyticsSnapshot,
  DeviceAnalyticsSyncState,
  GatewayRuntimeDeviceSummary,
  GetDeviceAnalyticsInput,
} from "@core/contracts";

const ANALYTICS_CACHE_KEY = "gym-motion.desktop.analytics-cache.v1";

type CachedAnalyticsMap = Record<string, DeviceAnalyticsSnapshot>;

type AnalyticsServiceDeps = {
  store: PreferencesStore;
  getRuntimeDevice: (deviceId: string) => GatewayRuntimeDeviceSummary | null;
  onUpdated: (analytics: DeviceAnalyticsSnapshot) => void;
  listMotionRollupBuckets?: typeof listMotionRollupBuckets;
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
  listMotionRollupBuckets: typeof listMotionRollupBuckets;
  getDeviceSyncState: typeof getDeviceSyncState;
}): Promise<DeviceAnalyticsSnapshot> {
  const definition = WINDOW_DEFINITIONS[args.window];
  const { start, end, buckets } = createBuckets(definition, Date.now());
  const [rollupBuckets, syncSummary] = await Promise.all([
    args.listMotionRollupBuckets({
      deviceId: args.deviceId,
      window: args.window,
      startBucket: start,
      endBucketExclusive: end,
    }),
    args.getDeviceSyncState(args.deviceId),
  ]);

  const bucketByStart = new Map(
    buckets.map((bucket) => [Date.parse(bucket.startAt), bucket] as const),
  );

  for (const rollupBucket of rollupBuckets) {
    const bucket = bucketByStart.get(rollupBucket.bucketStart);

    if (!bucket) {
      continue;
    }

    bucket.movementCount = rollupBucket.movementCount;
    bucket.movingSeconds = rollupBucket.movingSeconds;
  }

  const totalMovementCount = buckets.reduce((sum, bucket) => sum + bucket.movementCount, 0);
  const totalMovingSeconds = buckets.reduce((sum, bucket) => sum + bucket.movingSeconds, 0);

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
  const loadMotionRollupBuckets = deps.listMotionRollupBuckets ?? listMotionRollupBuckets;
  const loadDeviceSyncState = deps.getDeviceSyncState ?? getDeviceSyncState;

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

      const syncSummary = await loadDeviceSyncState(deviceId);
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
        listMotionRollupBuckets: loadMotionRollupBuckets,
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
        const syncSummary = await loadDeviceSyncState(input.deviceId);
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
        listMotionRollupBuckets: loadMotionRollupBuckets,
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
