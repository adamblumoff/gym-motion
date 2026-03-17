import { getDb } from "../db";
import type {
  DeviceMovementAnalytics,
  DeviceMovementAnalyticsResult,
  MovementAnalyticsBucket,
  MovementAnalyticsRange,
  MotionState,
} from "../motion";

type MotionAnalyticsEventRow = {
  state: MotionState;
  received_at: Date;
};

type CompactionNoticeRow = {
  message: string;
};

const RANGE_CONFIG: Record<
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
  precedingEvent: MotionAnalyticsEventRow | null;
  events: MotionAnalyticsEventRow[];
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
  const bucketSizeMs = RANGE_CONFIG[range].bucketMs;
  const buckets = buildBuckets(range, rangeStartAt, rangeEndAt, timezone, bucketSizeMs);
  let currentState: MotionState = precedingEvent?.state ?? "still";
  let currentMovingStartAt: Date | null =
    currentState === "moving" ? rangeStartAt : null;
  let currentMovingCarriesIntoRange = currentState === "moving";

  for (const event of events) {
    const eventAt = event.received_at;

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

export async function getDeviceMovementAnalytics(
  deviceId: string,
  range: MovementAnalyticsRange,
): Promise<DeviceMovementAnalyticsResult> {
  const now = new Date();
  const { windowMs } = RANGE_CONFIG[range];
  const rangeEndAt = now;
  const rangeStartAt = new Date(now.getTime() - windowMs);
  const db = getDb();

  const [precedingResult, eventsResult, olderHistoryResult, lastEventResult, compactionResult] =
    await Promise.all([
      db.query<MotionAnalyticsEventRow>(
        `select
           state,
           received_at
         from motion_events
         where device_id = $1
           and received_at < $2
         order by received_at desc, id desc
         limit 1`,
        [deviceId, rangeStartAt.toISOString()],
      ),
      db.query<MotionAnalyticsEventRow>(
        `select
           state,
           received_at
         from motion_events
         where device_id = $1
           and received_at >= $2
           and received_at <= $3
         order by received_at asc, id asc`,
        [deviceId, rangeStartAt.toISOString(), rangeEndAt.toISOString()],
      ),
      db.query<{ has_older_history: boolean }>(
        `select exists(
           select 1
           from motion_events
           where device_id = $1
             and received_at < $2
         ) as has_older_history`,
        [deviceId, rangeStartAt.toISOString()],
      ),
      db.query<{ received_at: Date }>(
        `select received_at
         from motion_events
         where device_id = $1
         order by received_at desc, id desc
         limit 1`,
        [deviceId],
      ),
      db.query<CompactionNoticeRow>(
        `select message
         from device_logs
         where device_id = $1
           and code in (
             'movement.archive.compacted',
             'movement.archive.storage_pressure',
             'history.compacted',
             'history.storage_pressure'
           )
         order by received_at desc, id desc
         limit 1`,
        [deviceId],
      ),
    ]);

  const analytics = buildMovementAnalyticsFromEvents({
    deviceId,
    range,
    rangeStartAt,
    rangeEndAt,
    precedingEvent: precedingResult.rows[0] ?? null,
    events: eventsResult.rows,
    hasOlderHistory: olderHistoryResult.rows[0]?.has_older_history ?? false,
    lastCanonicalEventAt: lastEventResult.rows[0]?.received_at?.toISOString() ?? null,
    compactionNotice: compactionResult.rows[0]?.message ?? null,
  });

  return {
    analytics,
    fromCache: false,
  };
}

export async function deleteDeviceMovementHistory(deviceId: string) {
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `insert into device_history_watermarks (
         device_id,
         deleted_before,
         updated_at
       )
       values ($1, now(), now())
       on conflict (device_id) do update
       set deleted_before = excluded.deleted_before,
           updated_at = now()`,
      [deviceId],
    );
    await client.query(
      `delete from motion_events
       where device_id = $1`,
      [deviceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
