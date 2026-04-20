import type { AnalyticsWindow, DeviceAnalyticsSnapshot, MotionEventSummary } from "@core/contracts";
import { getMotionEventTimelineTimestamp } from "@core/contracts";
import { summarizeMotionEventsInBuckets, WINDOW_DEFINITIONS } from "../../../backend/data";

export type LiveMotionEventMap = Map<string, MotionEventSummary[]>;

export function createInactiveLiveOverlay(lastEventReceivedAt: string | null) {
  return {
    active: false,
    generatedAt: null,
    totalMovementCount: 0,
    totalMovingSeconds: 0,
    lastEventReceivedAt,
  };
}

export function mergeLiveOverlayIntoSnapshot(
  snapshot: DeviceAnalyticsSnapshot,
  liveEvents: MotionEventSummary[],
): DeviceAnalyticsSnapshot {
  const definition = WINDOW_DEFINITIONS[snapshot.window as AnalyticsWindow];
  if (!definition || liveEvents.length === 0 || snapshot.buckets.length === 0) {
    return {
      ...snapshot,
      liveOverlay: createInactiveLiveOverlay(null),
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
      liveOverlay: createInactiveLiveOverlay(lastEventReceivedAt),
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

export function pruneLiveMotionEvents(
  liveMotionEvents: LiveMotionEventMap,
  deviceId: string,
  nowTimestamp: number,
) {
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
