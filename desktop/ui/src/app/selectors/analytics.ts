import type {
  DesktopSnapshot,
  DeviceMovementAnalytics,
  MovementAnalyticsRange,
} from "@core/contracts";
import {
  buildMovementAnalyticsFromEvents,
  MOVEMENT_ANALYTICS_RANGE_CONFIG,
} from "@core/movement-analytics";

export type MovementChartPoint = {
  bucketStartAt: string;
  label: string;
  movementCount: number;
  movementDurationMinutes: number;
  canonicalMovementCount: number;
  canonicalMovementDurationMinutes: number;
  provisionalMovementCount: number;
  provisionalMovementDurationMinutes: number;
};

export function buildLiveMovementAnalytics(args: {
  snapshot: DesktopSnapshot | null;
  deviceId: string | null;
  range: MovementAnalyticsRange;
  now?: Date;
  provisionalStartAt?: Date | null;
}) {
  const { snapshot, deviceId, range } = args;

  if (!snapshot || !deviceId) {
    return null;
  }

  const now = args.now ?? new Date();
  const rangeEndAt = now;
  const rangeStartAt = args.provisionalStartAt
    ? new Date(args.provisionalStartAt)
    : new Date(now.getTime() - MOVEMENT_ANALYTICS_RANGE_CONFIG[range].windowMs);
  const events = snapshot.events
    .filter((event) => event.deviceId === deviceId)
    .map((event) => ({
      state: event.state,
      receivedAt: new Date(event.receivedAt),
    }))
    .filter((event) => event.receivedAt >= rangeStartAt && event.receivedAt <= rangeEndAt)
    .toSorted((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime());
  const runtimeDevice = snapshot.devices.find((device) => device.id === deviceId) ?? null;
  const currentState = runtimeDevice?.lastState ?? "still";
  const lastEventReceivedAt = runtimeDevice?.lastEventReceivedAt
    ? new Date(runtimeDevice.lastEventReceivedAt)
    : null;
  const precedingEvent =
    currentState === "moving" &&
    lastEventReceivedAt &&
    lastEventReceivedAt < rangeStartAt
      ? {
          state: "moving" as const,
          receivedAt: lastEventReceivedAt,
        }
      : null;

  if (events.length === 0 && !precedingEvent && currentState !== "moving") {
    return null;
  }

  return buildMovementAnalyticsFromEvents({
    deviceId,
    range,
    rangeStartAt,
    rangeEndAt,
    precedingEvent,
    events,
    hasOlderHistory: false,
    lastCanonicalEventAt: null,
    compactionNotice: null,
  });
}

export function combineMovementAnalytics(
  canonical: DeviceMovementAnalytics | null,
  provisional: DeviceMovementAnalytics | null,
) {
  const orderedBuckets = new Map<string, MovementChartPoint>();

  for (const bucket of canonical?.buckets ?? []) {
    orderedBuckets.set(bucket.bucketStartAt, {
      bucketStartAt: bucket.bucketStartAt,
      label: bucket.label,
      movementCount: bucket.movementCount,
      movementDurationMinutes: Math.round(bucket.movementDurationMs / 60000),
      canonicalMovementCount: bucket.movementCount,
      canonicalMovementDurationMinutes: Math.round(bucket.movementDurationMs / 60000),
      provisionalMovementCount: 0,
      provisionalMovementDurationMinutes: 0,
    });
  }

  for (const bucket of provisional?.buckets ?? []) {
    const existing = orderedBuckets.get(bucket.bucketStartAt);
    const provisionalDurationMinutes = Math.round(bucket.movementDurationMs / 60000);

    if (existing) {
      existing.provisionalMovementCount = bucket.movementCount;
      existing.provisionalMovementDurationMinutes = provisionalDurationMinutes;
      existing.movementCount += bucket.movementCount;
      existing.movementDurationMinutes += provisionalDurationMinutes;
      continue;
    }

    orderedBuckets.set(bucket.bucketStartAt, {
      bucketStartAt: bucket.bucketStartAt,
      label: bucket.label,
      movementCount: bucket.movementCount,
      movementDurationMinutes: provisionalDurationMinutes,
      canonicalMovementCount: 0,
      canonicalMovementDurationMinutes: 0,
      provisionalMovementCount: bucket.movementCount,
      provisionalMovementDurationMinutes: provisionalDurationMinutes,
    });
  }

  return [...orderedBuckets.values()].toSorted(
    (left, right) =>
      new Date(left.bucketStartAt).getTime() - new Date(right.bucketStartAt).getTime(),
  );
}

export function summarizeMovementChart(points: MovementChartPoint[]) {
  return points.reduce(
    (summary, point) => ({
      movementCount: summary.movementCount + point.movementCount,
      movementDurationMinutes:
        summary.movementDurationMinutes + point.movementDurationMinutes,
    }),
    {
      movementCount: 0,
      movementDurationMinutes: 0,
    },
  );
}

export function formatDurationLabel(totalMinutes: number) {
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}
