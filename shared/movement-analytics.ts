import type {
  DeviceMovementAnalytics,
  MovementAnalyticsBucket,
  MovementAnalyticsRange,
  MotionState,
} from "./contracts";

export type MovementAnalyticsEventLike = {
  state: MotionState;
  receivedAt: Date;
};

export const MOVEMENT_ANALYTICS_RANGE_CONFIG: Record<
  MovementAnalyticsRange,
  {
    windowMs: number;
    bucketMs: number;
  }
> = {
  "24h": {
    windowMs: 24 * 60 * 60 * 1000,
    bucketMs: 15 * 60 * 1000,
  },
  "7d": {
    windowMs: 7 * 24 * 60 * 60 * 1000,
    bucketMs: 2 * 60 * 60 * 1000,
  },
};

function rangeLabel(
  range: MovementAnalyticsRange,
  bucketStartAt: Date,
  timezone: string,
) {
  if (range === "24h") {
    return bucketStartAt.toLocaleTimeString("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return bucketStartAt.toLocaleDateString("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour12: false,
    hour: "2-digit",
  });
}

function buildBuckets(
  range: MovementAnalyticsRange,
  rangeStartAt: Date,
  rangeEndAt: Date,
  timezone: string,
  bucketSizeMs: number,
): MovementAnalyticsBucket[] {
  const buckets: MovementAnalyticsBucket[] = [];

  for (
    let bucketStartMs = rangeStartAt.getTime();
    bucketStartMs < rangeEndAt.getTime();
    bucketStartMs += bucketSizeMs
  ) {
    const bucketStartAt = new Date(bucketStartMs);
    const bucketEndAt = new Date(Math.min(bucketStartMs + bucketSizeMs, rangeEndAt.getTime()));

    buckets.push({
      bucketStartAt: bucketStartAt.toISOString(),
      bucketEndAt: bucketEndAt.toISOString(),
      label: rangeLabel(range, bucketStartAt, timezone),
      movementCount: 0,
      movementDurationMs: 0,
    });
  }

  return buckets;
}

function addMovingSpanToBuckets(
  buckets: MovementAnalyticsBucket[],
  spanStartAt: Date,
  spanEndAt: Date,
  countSpanStart: boolean,
) {
  if (spanEndAt <= spanStartAt) {
    return;
  }

  let countedStart = !countSpanStart;

  for (const bucket of buckets) {
    const bucketStartMs = new Date(bucket.bucketStartAt).getTime();
    const bucketEndMs = new Date(bucket.bucketEndAt).getTime();
    const overlapStartMs = Math.max(bucketStartMs, spanStartAt.getTime());
    const overlapEndMs = Math.min(bucketEndMs, spanEndAt.getTime());

    if (overlapEndMs <= overlapStartMs) {
      continue;
    }

    bucket.movementDurationMs += overlapEndMs - overlapStartMs;

    if (!countedStart && spanStartAt.getTime() >= bucketStartMs && spanStartAt.getTime() < bucketEndMs) {
      bucket.movementCount += 1;
      countedStart = true;
    }
  }
}

export function buildMovementAnalyticsFromEvents(args: {
  deviceId: string;
  range: MovementAnalyticsRange;
  rangeStartAt: Date;
  rangeEndAt: Date;
  precedingEvent: MovementAnalyticsEventLike | null;
  events: MovementAnalyticsEventLike[];
  hasOlderHistory: boolean;
  lastCanonicalEventAt: string | null;
  compactionNotice: string | null;
  timezone?: string;
  computedAt?: Date;
}) {
  const {
    deviceId,
    range,
    rangeStartAt,
    rangeEndAt,
    precedingEvent,
    events,
    hasOlderHistory,
    lastCanonicalEventAt,
    compactionNotice,
  } = args;
  const timezone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const computedAt = args.computedAt ?? new Date();
  const bucketSizeMs = MOVEMENT_ANALYTICS_RANGE_CONFIG[range].bucketMs;
  const buckets = buildBuckets(range, rangeStartAt, rangeEndAt, timezone, bucketSizeMs);
  let currentState: MotionState = precedingEvent?.state ?? "still";
  let currentMovingStartAt: Date | null =
    currentState === "moving" ? rangeStartAt : null;
  let currentMovingCarriesIntoRange = currentState === "moving";

  for (const event of events) {
    const eventAt = event.receivedAt;

    if (currentState === "moving" && event.state === "still" && currentMovingStartAt) {
      addMovingSpanToBuckets(
        buckets,
        currentMovingStartAt,
        eventAt,
        !currentMovingCarriesIntoRange,
      );
      currentMovingStartAt = null;
      currentMovingCarriesIntoRange = false;
    }

    if (event.state === "moving" && currentState !== "moving") {
      currentMovingStartAt = eventAt;
      currentMovingCarriesIntoRange = false;
    }

    currentState = event.state;
  }

  if (currentState === "moving" && currentMovingStartAt) {
    addMovingSpanToBuckets(
      buckets,
      currentMovingStartAt,
      rangeEndAt,
      !currentMovingCarriesIntoRange,
    );
  }

  const analytics: DeviceMovementAnalytics = {
    deviceId,
    range,
    rangeStartAt: rangeStartAt.toISOString(),
    rangeEndAt: rangeEndAt.toISOString(),
    timezone,
    bucketSizeMs,
    buckets,
    lastCanonicalEventAt,
    lastComputedAt: computedAt.toISOString(),
    hasCanonicalHistory: events.length > 0 || precedingEvent !== null,
    hasOlderHistory,
    compactionNotice,
  };

  return analytics;
}
