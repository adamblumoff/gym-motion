import { getDb } from "@/lib/db";
import type {
  DeviceSummary,
  IngestPayload,
  MotionEventSummary,
} from "@/lib/motion";

type DeviceRow = {
  id: string;
  last_state: DeviceSummary["lastState"];
  last_seen_at: string | number;
  last_delta: number | null;
  updated_at: Date;
};

type MotionEventRow = {
  id: string | number;
  device_id: string;
  state: MotionEventSummary["state"];
  delta: number | null;
  event_timestamp: string | number;
  received_at: Date;
};

function toSafeNumber(value: string | number) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(numericValue)) {
    throw new Error(`Value is not a safe integer: ${value}`);
  }

  return numericValue;
}

export async function recordMotionEvent(payload: IngestPayload) {
  const delta = payload.delta ?? null;
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `insert into motion_events (device_id, state, delta, event_timestamp)
       values ($1, $2, $3, $4)`,
      [payload.deviceId, payload.state, delta, payload.timestamp],
    );

    await client.query(
      `insert into devices (id, last_state, last_seen_at, last_delta, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (id) do update
       set last_state = excluded.last_state,
           last_seen_at = excluded.last_seen_at,
           last_delta = excluded.last_delta,
           updated_at = now()`,
      [payload.deviceId, payload.state, payload.timestamp, delta],
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
    `select id, last_state, last_seen_at, last_delta, updated_at
     from devices
     order by updated_at desc, id asc`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    lastState: row.last_state,
    lastSeenAt: toSafeNumber(row.last_seen_at),
    lastDelta: row.last_delta,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function listRecentEvents(limit = 12): Promise<MotionEventSummary[]> {
  const result = await getDb().query<MotionEventRow>(
    `select id, device_id, state, delta, event_timestamp, received_at
     from motion_events
     order by received_at desc, id desc
     limit $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    id: toSafeNumber(row.id),
    deviceId: row.device_id,
    state: row.state,
    delta: row.delta,
    eventTimestamp: toSafeNumber(row.event_timestamp),
    receivedAt: row.received_at.toISOString(),
  }));
}
