import {
  findLatestDeviceMotionEventBeforeReceivedAt,
  hasMotionRollupTables,
  listMotionRollupBuckets,
  listDeviceMotionEventsByReceivedAt,
} from "../../../backend/data";
import type { PreferencesStore } from "../preferences-store";
import type {
  AnalyticsWindow,
  DeviceAnalyticsBucket,
  DeviceAnalyticsSnapshot,
  GatewayRuntimeDeviceSummary,
  GetDeviceAnalyticsInput,
  MotionEventSummary,
} from "@core/contracts";
import { getMotionEventTimelineTimestamp } from "@core/contracts";

const ANALYTICS_CACHE_KEY = "gym-motion.desktop.analytics-cache.v2";

type CachedAnalyticsMap = Record<string, DeviceAnalyticsSnapshot>;
type LiveMotionEventMap = Map<string, MotionEventSummary[]>;

type AnalyticsServiceDeps = {
  store: PreferencesStore;
  getRuntimeDevice: (deviceId: string) => GatewayRuntimeDeviceSummary | null;
  onUpdated: (analytics: DeviceAnalyticsSnapshot) => void;
  hasMotionRollupTables?: typeof hasMotionRollupTables;
  listMotionRollupBuckets?: typeof listMotionRollupBuckets;
  listDeviceMotionEventsByReceivedAt?: typeof listDeviceMotionEventsByReceivedAt;
  findLatestDeviceMotionEventBeforeReceivedAt?: typeof findLatestDeviceMotionEventBeforeReceivedAt;
};

type WindowDefinition = {
  window: AnalyticsWindow;
  bucketMs: number;
  bucketCount: number;
  labelFormatter: (timestamp: number) => string;
};

function isAnalyticsWindow(value: unknown): value is AnalyticsWindow {
  return value === "24h" || value === "7d";
}

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

function isDeviceAnalyticsBucket(value: unknown): value is DeviceAnalyticsBucket {
  if (!value || typeof value !== "object") {
    return false;
  }

  const bucket = value as Record<string, unknown>;
  return (
    typeof bucket.key === "string" &&
    typeof bucket.label === "string" &&
    typeof bucket.startAt === "string" &&
    typeof bucket.endAt === "string" &&
    typeof bucket.movementCount === "number" &&
    typeof bucket.movingSeconds === "number"
  );
}

function isDeviceAnalyticsSnapshot(value: unknown): value is DeviceAnalyticsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.deviceId === "string" &&
    isAnalyticsWindow(snapshot.window) &&
    typeof snapshot.generatedAt === "string" &&
    (snapshot.source === "cache" || snapshot.source === "canonical") &&
    Array.isArray(snapshot.buckets) &&
    snapshot.buckets.every(isDeviceAnalyticsBucket) &&
    typeof snapshot.totalMovementCount === "number" &&
    typeof snapshot.totalMovingSeconds === "number"
  );
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

function summarizeMotionRollupBuckets(
  buckets: DeviceAnalyticsBucket[],
  rollupBuckets: Awaited<ReturnType<typeof listMotionRollupBuckets>>,
) {
  const rollupsByStart = new Map<
    number,
    Awaited<ReturnType<typeof listMotionRollupBuckets>>[number]
  >();

  for (const rollupBucket of rollupBuckets) {
    rollupsByStart.set(rollupBucket.bucketStart, rollupBucket);
  }

  const nextBuckets = buckets.map((bucket) => {
    const rollupBucket = rollupsByStart.get(Date.parse(bucket.startAt));

    if (!rollupBucket) {
      return bucket;
    }

    return {
      ...bucket,
      movementCount: rollupBucket.movementCount,
      movingSeconds: rollupBucket.movingSeconds,
    };
  });

  return {
    buckets: nextBuckets,
    totalMovementCount: nextBuckets.reduce((sum, bucket) => sum + bucket.movementCount, 0),
    totalMovingSeconds: Math.round(
      nextBuckets.reduce((sum, bucket) => sum + bucket.movingSeconds, 0),
    ),
  };
}

export function summarizeMotionEventsInBuckets(args: {
  buckets: DeviceAnalyticsBucket[];
  bucketMs: number;
  windowStart: number;
  windowEnd: number;
  precedingState: MotionEventSummary["state"] | null;
  events: MotionEventSummary[];
  segmentStart?: number;
}) {
  const {
    buckets,
    bucketMs,
    windowStart,
    windowEnd,
    precedingState,
    events,
    segmentStart,
  } = args;
  let currentState = precedingState ?? "still";
  let currentSegmentStart = Math.max(windowStart, segmentStart ?? windowStart);

  for (const event of events) {
    const timelineTimestamp = getMotionEventTimelineTimestamp(event);

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

  if (currentState === "moving") {
    addMovingDuration(
      buckets,
      bucketMs,
      windowStart,
      windowEnd,
      currentSegmentStart,
      windowEnd,
    );
  }

  return {
    buckets,
    totalMovementCount: buckets.reduce((sum, bucket) => sum + bucket.movementCount, 0),
    totalMovingSeconds: Math.round(
      buckets.reduce((sum, bucket) => sum + bucket.movingSeconds, 0),
    ),
  };
}

async function buildAnalyticsSnapshot(args: {
  deviceId: string;
  window: AnalyticsWindow;
  hasMotionRollupTables: typeof hasMotionRollupTables;
  listMotionRollupBuckets: typeof listMotionRollupBuckets;
  listDeviceMotionEventsByReceivedAt: typeof listDeviceMotionEventsByReceivedAt;
  findLatestDeviceMotionEventBeforeReceivedAt: typeof findLatestDeviceMotionEventBeforeReceivedAt;
}): Promise<DeviceAnalyticsSnapshot> {
  const definition = WINDOW_DEFINITIONS[args.window];
  const { start, end, buckets } = createBuckets(definition, Date.now());
  const windowStartAt = new Date(start).toISOString();
  const windowEndAt = new Date(end).toISOString();

  const loadRawMotionSummary = async () => {
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

    return summarizeMotionEventsInBuckets({
      buckets: buckets.map((bucket) => ({
        ...bucket,
        movementCount: 0,
        movingSeconds: 0,
      })),
      bucketMs: definition.bucketMs,
      windowStart: start,
      windowEnd: end,
      precedingState: precedingEvent?.state ?? null,
      events,
    });
  };

  let summary:
    | ReturnType<typeof summarizeMotionEventsInBuckets>
    | ReturnType<typeof summarizeMotionRollupBuckets>;

  if (await args.hasMotionRollupTables()) {
    const rollupBuckets = await args.listMotionRollupBuckets({
      deviceId: args.deviceId,
      window: args.window,
      startBucket: start,
      endBucketExclusive: end,
    });
    const rollupSummary = summarizeMotionRollupBuckets(buckets, rollupBuckets);
    summary =
      rollupSummary.totalMovementCount > 0 || rollupSummary.totalMovingSeconds > 0
        ? rollupSummary
        : await loadRawMotionSummary();
  } else {
    summary = await loadRawMotionSummary();
  }

  return {
    deviceId: args.deviceId,
    window: args.window,
    generatedAt: new Date().toISOString(),
    source: "canonical",
    buckets: summary.buckets,
    totalMovementCount: summary.totalMovementCount,
    totalMovingSeconds: summary.totalMovingSeconds,
  };
}

export type AnalyticsService = {
  getDeviceAnalytics: (input: GetDeviceAnalyticsInput) => Promise<DeviceAnalyticsSnapshot>;
  scheduleRefresh: (deviceId: string, delayMs?: number) => void;
  recordLiveMotion: (event: MotionEventSummary) => void;
};

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const liveMotionEvents: LiveMotionEventMap = new Map();
  const checkHasMotionRollups = deps.hasMotionRollupTables ?? hasMotionRollupTables;
  const loadMotionRollupBuckets = deps.listMotionRollupBuckets ?? listMotionRollupBuckets;
  const loadMotionEventsByReceivedAt =
    deps.listDeviceMotionEventsByReceivedAt ?? listDeviceMotionEventsByReceivedAt;
  const loadLatestMotionEventBeforeReceivedAt =
    deps.findLatestDeviceMotionEventBeforeReceivedAt ??
    findLatestDeviceMotionEventBeforeReceivedAt;

  function readCache(): CachedAnalyticsMap {
    const rawCache = deps.store.getJson<Record<string, unknown>>(ANALYTICS_CACHE_KEY) ?? {};
    const cache: CachedAnalyticsMap = {};

    for (const [key, value] of Object.entries(rawCache)) {
      if (isDeviceAnalyticsSnapshot(value)) {
        cache[key] = value;
      }
    }

    return cache;
  }

  function writeCache(cache: CachedAnalyticsMap) {
    deps.store.setJson(ANALYTICS_CACHE_KEY, cache);
  }

  function pruneLiveMotionEvents(deviceId: string, nowTimestamp: number) {
    const retained = (liveMotionEvents.get(deviceId) ?? []).filter((event) => {
      const timestamp = getMotionEventTimelineTimestamp(event);
      return Number.isFinite(timestamp) && timestamp >= nowTimestamp - 8 * 24 * 60 * 60 * 1000;
    });

    if (retained.length === 0) {
      liveMotionEvents.delete(deviceId);
      return;
    }

    liveMotionEvents.set(deviceId, retained);
  }

  function mergeLiveOverlayIntoSnapshot(
    snapshot: DeviceAnalyticsSnapshot,
    deviceId: string,
  ): DeviceAnalyticsSnapshot {
    const liveEvents = liveMotionEvents.get(deviceId) ?? [];
    const definition = WINDOW_DEFINITIONS[snapshot.window];
    if (!definition || liveEvents.length === 0 || snapshot.buckets.length === 0) {
      return {
        ...snapshot,
        liveOverlay: {
          active: false,
          generatedAt: null,
          totalMovementCount: 0,
          totalMovingSeconds: 0,
          lastEventReceivedAt: null,
        },
      };
    }

    const windowStart = Date.parse(snapshot.buckets[0]?.startAt ?? snapshot.generatedAt);
    const overlayStart = Math.max(windowStart, Date.parse(snapshot.generatedAt));
    const nowTimestamp = Date.now();
    const relevantEvents = liveEvents.filter((event) => {
      const timestamp = getMotionEventTimelineTimestamp(event);
      return Number.isFinite(timestamp) && timestamp > overlayStart && timestamp <= nowTimestamp;
    });
    const precedingEvent = [...liveEvents]
      .reverse()
      .find((event) => getMotionEventTimelineTimestamp(event) <= overlayStart);
    const overlaySummary = summarizeMotionEventsInBuckets({
      buckets: snapshot.buckets.map((bucket) => ({
        ...bucket,
        movementCount: 0,
        movingSeconds: 0,
      })),
      bucketMs: definition.bucketMs,
      windowStart,
      windowEnd: nowTimestamp,
      segmentStart: overlayStart,
      precedingState: precedingEvent?.state ?? null,
      events: relevantEvents,
    });
    const lastEventReceivedAt =
      relevantEvents.length > 0 ? relevantEvents[relevantEvents.length - 1]?.receivedAt ?? null : null;
    const overlayActive =
      overlaySummary.totalMovementCount > 0 || overlaySummary.totalMovingSeconds > 0;

    if (!overlayActive) {
      return {
        ...snapshot,
        liveOverlay: {
          active: false,
          generatedAt: null,
          totalMovementCount: 0,
          totalMovingSeconds: 0,
          lastEventReceivedAt,
        },
      };
    }

    return {
      ...snapshot,
      buckets: snapshot.buckets.map((bucket, index) => ({
        ...bucket,
        movementCount: bucket.movementCount + overlaySummary.buckets[index].movementCount,
        movingSeconds: bucket.movingSeconds + overlaySummary.buckets[index].movingSeconds,
      })),
      totalMovementCount: snapshot.totalMovementCount + overlaySummary.totalMovementCount,
      totalMovingSeconds: snapshot.totalMovingSeconds + overlaySummary.totalMovingSeconds,
      liveOverlay: {
        active: true,
        generatedAt: new Date(nowTimestamp).toISOString(),
        totalMovementCount: overlaySummary.totalMovementCount,
        totalMovingSeconds: overlaySummary.totalMovingSeconds,
        lastEventReceivedAt,
      },
    };
  }

  function emitMergedCachedSnapshots(deviceId: string) {
    const cache = readCache();
    for (const window of Object.keys(WINDOW_DEFINITIONS) as AnalyticsWindow[]) {
      const cached = cache[cacheKey(deviceId, window)];
      if (!cached) {
        continue;
      }

      deps.onUpdated(mergeLiveOverlayIntoSnapshot(cached, deviceId));
    }
  }

  async function refreshDevice(deviceId: string) {
    const nextCache = {
      ...readCache(),
    };

    for (const window of Object.keys(WINDOW_DEFINITIONS) as AnalyticsWindow[]) {
      const analytics = await buildAnalyticsSnapshot({
        deviceId,
        window,
        hasMotionRollupTables: checkHasMotionRollups,
        listMotionRollupBuckets: loadMotionRollupBuckets,
        listDeviceMotionEventsByReceivedAt: loadMotionEventsByReceivedAt,
        findLatestDeviceMotionEventBeforeReceivedAt:
          loadLatestMotionEventBeforeReceivedAt,
      });
      nextCache[cacheKey(deviceId, window)] = analytics;
      deps.onUpdated(mergeLiveOverlayIntoSnapshot(analytics, deviceId));
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
        console.error("[runtime] analytics refresh failed", error);
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
        return mergeLiveOverlayIntoSnapshot(
          {
            ...cached,
            source: "cache",
          },
          input.deviceId,
        );
      }

      const analytics = await buildAnalyticsSnapshot({
        deviceId: input.deviceId,
        window: input.window,
        hasMotionRollupTables: checkHasMotionRollups,
        listMotionRollupBuckets: loadMotionRollupBuckets,
        listDeviceMotionEventsByReceivedAt: loadMotionEventsByReceivedAt,
        findLatestDeviceMotionEventBeforeReceivedAt:
          loadLatestMotionEventBeforeReceivedAt,
      });

      writeCache({
        ...cache,
        [cacheKey(input.deviceId, input.window)]: analytics,
      });

      return mergeLiveOverlayIntoSnapshot(analytics, input.deviceId);
    },

    scheduleRefresh,

    recordLiveMotion(event) {
      const current = liveMotionEvents.get(event.deviceId) ?? [];
      const nextEvents = [...current, event].sort(
        (left, right) =>
          Date.parse(left.receivedAt) - Date.parse(right.receivedAt) || left.id - right.id,
      );
      liveMotionEvents.set(event.deviceId, nextEvents);
      pruneLiveMotionEvents(event.deviceId, Date.now());
      emitMergedCachedSnapshots(event.deviceId);
    },
  };
}
