import { getDb } from "../db";
import type {
  DeviceMovementAnalyticsResult,
  MovementAnalyticsRange,
} from "../motion";
import {
  buildMovementAnalyticsFromEvents,
  MOVEMENT_ANALYTICS_RANGE_CONFIG,
} from "../../../shared/movement-analytics";

type MotionAnalyticsEventRow = {
  state: "moving" | "still";
  received_at: Date;
};

type CompactionNoticeRow = {
  message: string;
};

export { buildMovementAnalyticsFromEvents } from "../../../shared/movement-analytics";

export async function getDeviceMovementAnalytics(
  deviceId: string,
  range: MovementAnalyticsRange,
): Promise<DeviceMovementAnalyticsResult> {
  const now = new Date();
  const { windowMs } = MOVEMENT_ANALYTICS_RANGE_CONFIG[range];
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
    precedingEvent: precedingResult.rows[0]
      ? {
          state: precedingResult.rows[0].state,
          receivedAt: precedingResult.rows[0].received_at,
        }
      : null,
    events: eventsResult.rows.map((event) => ({
      state: event.state,
      receivedAt: event.received_at,
    })),
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
