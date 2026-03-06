import { getDb } from "@/lib/db";
import type {
  DeviceSummary,
  IngestPayload,
  MotionEventSummary,
} from "@/lib/motion";
import { toEventDate } from "@/lib/motion";

type DeviceRow = {
  id: string;
  last_state: DeviceSummary["lastState"];
  last_seen_at: Date;
  last_delta: number | null;
};

type MotionEventRow = {
  id: number;
  device_id: string;
  state: MotionEventSummary["state"];
  delta: number | null;
  event_timestamp: Date;
  received_at: Date;
};

export async function recordMotionEvent(payload: IngestPayload) {
  const eventDate = toEventDate(payload.timestamp);
  const delta = payload.delta ?? null;
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `insert into motion_events (device_id, state, delta, event_timestamp)
       values ($1, $2, $3, $4)`,
      [payload.deviceId, payload.state, delta, eventDate],
    );

    await client.query(
      `insert into devices (id, last_state, last_seen_at, last_delta, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (id) do update
       set last_state = excluded.last_state,
           last_seen_at = excluded.last_seen_at,
           last_delta = excluded.last_delta,
           updated_at = now()
       where excluded.last_seen_at >= devices.last_seen_at`,
      [payload.deviceId, payload.state, eventDate, delta],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listDevices(): Promise<DeviceSummary[]> {
  const result = await getDb().query<DeviceRow>(
    `select id, last_state, last_seen_at, last_delta
     from devices
     order by last_seen_at desc, id asc`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    lastState: row.last_state,
    lastSeenAt: row.last_seen_at.toISOString(),
    lastDelta: row.last_delta,
  }));
}

export async function listRecentEvents(limit = 12): Promise<MotionEventSummary[]> {
  const result = await getDb().query<MotionEventRow>(
    `select id, device_id, state, delta, event_timestamp, received_at
     from motion_events
     order by event_timestamp desc, id desc
     limit $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    state: row.state,
    delta: row.delta,
    eventTimestamp: row.event_timestamp.toISOString(),
    receivedAt: row.received_at.toISOString(),
  }));
}
