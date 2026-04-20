import {
  findLatestDeviceMotionEventBeforeReceivedAt,
  hasMotionRollupTables,
  listDeviceMotionEventsByReceivedAt,
  listMotionRollupBuckets,
} from "./repository";
import type {
  AnalyticsWindow,
  DeviceAnalyticsBucket,
  DeviceAnalyticsSnapshot,
  MotionEventSummary,
} from "../../shared/contracts";
import { getMotionEventTimelineTimestamp } from "../../shared/contracts";

export type WindowDefinition = {
  window: AnalyticsWindow;
  bucketMs: number;
  bucketCount: number;
  labelFormatter: (timestamp: number) => string;
};

export const WINDOW_DEFINITIONS: Record<AnalyticsWindow, WindowDefinition> = {
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

export function analyticsWindows(): AnalyticsWindow[] {
  return Object.keys(WINDOW_DEFINITIONS) as AnalyticsWindow[];
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

export async function buildAnalyticsSnapshot(args: {
  deviceId: string;
  window: AnalyticsWindow;
  hasMotionRollupTables?: typeof hasMotionRollupTables;
  listMotionRollupBuckets?: typeof listMotionRollupBuckets;
  listDeviceMotionEventsByReceivedAt?: typeof listDeviceMotionEventsByReceivedAt;
  findLatestDeviceMotionEventBeforeReceivedAt?: typeof findLatestDeviceMotionEventBeforeReceivedAt;
}): Promise<DeviceAnalyticsSnapshot> {
  const definition = WINDOW_DEFINITIONS[args.window];
  const { start, end, buckets } = createBuckets(definition, Date.now());
  const windowStartAt = new Date(start).toISOString();
  const windowEndAt = new Date(end).toISOString();
  const checkHasMotionRollups = args.hasMotionRollupTables ?? hasMotionRollupTables;
  const loadMotionRollupBuckets = args.listMotionRollupBuckets ?? listMotionRollupBuckets;
  const loadMotionEventsByReceivedAt =
    args.listDeviceMotionEventsByReceivedAt ?? listDeviceMotionEventsByReceivedAt;
  const loadLatestMotionEventBeforeReceivedAt =
    args.findLatestDeviceMotionEventBeforeReceivedAt ??
    findLatestDeviceMotionEventBeforeReceivedAt;

  const loadRawMotionSummary = async () => {
    const [events, precedingEvent] = await Promise.all([
      loadMotionEventsByReceivedAt({
        deviceId: args.deviceId,
        startReceivedAt: windowStartAt,
        endReceivedAt: windowEndAt,
      }),
      loadLatestMotionEventBeforeReceivedAt({
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

  if (await checkHasMotionRollups()) {
    const rollupBuckets = await loadMotionRollupBuckets({
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
