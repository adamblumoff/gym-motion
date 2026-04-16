import { getMotionEventTimelineTimestamp, type MotionEventSummary } from "../motion";

export type MotionRollupSummaryBucket = {
  movementCount: number;
  movingSeconds: number;
};

export function floorBucketStart(timestamp: number, bucketMs: number) {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

export function rangeEndBucketStart(
  rangeStart: number,
  rangeEndExclusive: number,
  bucketMs: number,
) {
  const terminalTimestamp = rangeEndExclusive > rangeStart ? rangeEndExclusive - 1 : rangeStart;
  return floorBucketStart(terminalTimestamp, bucketMs);
}

export function addMovingDuration(
  bucketMap: Map<number, MotionRollupSummaryBucket>,
  bucketMs: number,
  windowStart: number,
  windowEnd: number,
  startTimestamp: number,
  endTimestamp: number,
) {
  const clampedStart = Math.max(startTimestamp, windowStart);
  const clampedEnd = Math.min(endTimestamp, windowEnd);

  if (clampedEnd <= clampedStart) {
    return;
  }

  let cursor = clampedStart;

  while (cursor < clampedEnd) {
    const bucketStart = floorBucketStart(cursor, bucketMs);
    const bucket = bucketMap.get(bucketStart) ?? {
      movementCount: 0,
      movingSeconds: 0,
    };
    const bucketEnd = bucketStart + bucketMs;
    const segmentEnd = Math.min(bucketEnd, clampedEnd);
    bucket.movingSeconds += Math.round((segmentEnd - cursor) / 1000);
    bucketMap.set(bucketStart, bucket);
    cursor = segmentEnd;
  }
}

export function addMovementCount(
  bucketMap: Map<number, MotionRollupSummaryBucket>,
  bucketMs: number,
  windowStart: number,
  windowEnd: number,
  timestamp: number,
) {
  if (timestamp < windowStart || timestamp >= windowEnd) {
    return;
  }

  const bucketStart = floorBucketStart(timestamp, bucketMs);
  const bucket = bucketMap.get(bucketStart) ?? {
    movementCount: 0,
    movingSeconds: 0,
  };
  bucket.movementCount += 1;
  bucketMap.set(bucketStart, bucket);
}

export function summarizeEventsWithinWindow(args: {
  bucketMs: number;
  windowStart: number;
  windowEnd: number;
  precedingState: MotionEventSummary["state"] | null;
  events: MotionEventSummary[];
}) {
  const bucketMap = new Map<number, MotionRollupSummaryBucket>();
  let currentState = args.precedingState ?? "still";
  let currentTimestamp = args.windowStart;

  for (const event of args.events) {
    const eventTimestamp = getMotionEventTimelineTimestamp(event);

    if (!Number.isFinite(eventTimestamp)) {
      continue;
    }

    if (currentState === "moving" && eventTimestamp > currentTimestamp) {
      addMovingDuration(
        bucketMap,
        args.bucketMs,
        args.windowStart,
        args.windowEnd,
        currentTimestamp,
        eventTimestamp,
      );
    }

    if (event.state === "moving" && currentState !== "moving") {
      addMovementCount(
        bucketMap,
        args.bucketMs,
        args.windowStart,
        args.windowEnd,
        eventTimestamp,
      );
    }

    currentState = event.state;
    currentTimestamp = eventTimestamp;
  }

  return bucketMap;
}
