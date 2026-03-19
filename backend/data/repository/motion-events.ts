import { getDb } from "../db";
import type {
  DeviceSummary,
  HeartbeatPayload,
  IngestPayload,
  MotionEventSummary,
  MotionStreamPayload,
} from "../motion";
import {
  DEVICE_SELECT_COLUMNS,
  type DeviceRow,
  type MotionEventRow,
  mapDeviceRow,
  mapMotionEventRow,
} from "./shared";
import { refreshMotionRollupsForDeviceRange } from "./rollups";

function sequenceConflictClause() {
  return "(device_id, coalesce(boot_id, ''), sequence) where sequence is not null";
}

export async function recordMotionEvent(payload: IngestPayload): Promise<MotionStreamPayload> {
  const delta = payload.delta ?? null;
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");

    const upsertedDevice = await client.query<DeviceRow>(
      `insert into devices (
         id,
         last_state,
         last_seen_at,
         last_delta,
         updated_at,
         hardware_id,
         boot_id,
         firmware_version,
         provisioning_state,
         update_status,
         last_event_received_at
       )
       values ($1, $2, $3, $4, now(), $5, $6, $7, 'provisioned', 'idle', now())
       on conflict (id) do update
       set last_state = excluded.last_state,
           last_seen_at = excluded.last_seen_at,
           last_delta = excluded.last_delta,
           updated_at = now(),
           hardware_id = coalesce(excluded.hardware_id, devices.hardware_id),
           boot_id = coalesce(excluded.boot_id, devices.boot_id),
           firmware_version = excluded.firmware_version,
           provisioning_state = case
             when devices.provisioning_state in ('unassigned', 'assigned') then 'provisioned'
             else devices.provisioning_state
           end,
           last_event_received_at = now()
       returning
         ${DEVICE_SELECT_COLUMNS}`,
      [
        payload.deviceId,
        payload.state,
        payload.timestamp,
        delta,
        payload.hardwareId ?? null,
        payload.bootId ?? null,
        payload.firmwareVersion ?? "unknown",
      ],
    );

    const insertedEvent = await client.query<MotionEventRow>(
      `insert into motion_events (
         device_id,
         sequence,
         state,
         delta,
         event_timestamp,
         boot_id,
         firmware_version,
         hardware_id
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict ${sequenceConflictClause()} do nothing
       returning
         id,
         device_id,
         sequence,
         state,
         delta,
         event_timestamp,
         received_at,
         boot_id,
         firmware_version,
         hardware_id`,
      [
        payload.deviceId,
        payload.sequence ?? null,
        payload.state,
        delta,
        payload.timestamp,
        payload.bootId ?? null,
        payload.firmwareVersion ?? "unknown",
        payload.hardwareId ?? null,
      ],
    );

    const storedEvent = insertedEvent.rows[0]
      ? insertedEvent.rows[0]
      : payload.sequence === undefined
        ? null
        : (
            await client.query<MotionEventRow>(
              `select
                 id,
                 device_id,
                 sequence,
                 state,
                 delta,
                 event_timestamp,
                 received_at,
                 boot_id,
                 firmware_version,
                 hardware_id
               from motion_events
               where device_id = $1
                 and coalesce(boot_id, '') = coalesce($2, '')
                 and sequence = $3
               limit 1`,
              [payload.deviceId, payload.bootId ?? null, payload.sequence],
            )
          ).rows[0];

    if (insertedEvent.rows[0] && storedEvent) {
      const previousEvent = await client.query<MotionEventRow>(
        `select
           id,
           device_id,
           sequence,
           state,
           delta,
           event_timestamp,
           received_at,
           boot_id,
           firmware_version,
           hardware_id
         from motion_events
         where device_id = $1
           and event_timestamp < $2
         order by event_timestamp desc, id desc
         limit 1`,
        [payload.deviceId, storedEvent.event_timestamp],
      );
      const nextEvent = await client.query<MotionEventRow>(
        `select
           id,
           device_id,
           sequence,
           state,
           delta,
           event_timestamp,
           received_at,
           boot_id,
           firmware_version,
           hardware_id
         from motion_events
         where device_id = $1
           and event_timestamp > $2
         order by event_timestamp asc, id asc
         limit 1`,
        [payload.deviceId, storedEvent.event_timestamp],
      );
      const rangeStart = previousEvent.rows[0]
        ? Number(previousEvent.rows[0].event_timestamp)
        : Number(storedEvent.event_timestamp);
      const rangeEndExclusive = nextEvent.rows[0]
        ? Number(nextEvent.rows[0].event_timestamp)
        : Number(storedEvent.event_timestamp) + 1;

      await refreshMotionRollupsForDeviceRange({
        client,
        deviceId: payload.deviceId,
        rangeStart,
        rangeEndExclusive,
      });
    }

    await client.query("COMMIT");

    return {
      device: mapDeviceRow(upsertedDevice.rows[0]),
      event: storedEvent ? mapMotionEventRow(storedEvent) : undefined,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordHeartbeat(payload: HeartbeatPayload): Promise<MotionStreamPayload> {
  const result = await getDb().query<DeviceRow>(
    `insert into devices (
       id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       boot_id,
       firmware_version,
       provisioning_state,
       update_status,
       last_heartbeat_at
     )
     values ($1, 'still', $2, null, now(), $3, $4, $5, 'provisioned', 'idle', now())
     on conflict (id) do update
     set last_seen_at = excluded.last_seen_at,
         updated_at = now(),
         hardware_id = coalesce(excluded.hardware_id, devices.hardware_id),
         boot_id = coalesce(excluded.boot_id, devices.boot_id),
         firmware_version = excluded.firmware_version,
         provisioning_state = case
           when devices.provisioning_state in ('unassigned', 'assigned') then 'provisioned'
           else devices.provisioning_state
         end,
         last_heartbeat_at = now()
     returning
       ${DEVICE_SELECT_COLUMNS}`,
    [
      payload.deviceId,
      payload.timestamp,
      payload.hardwareId ?? null,
      payload.bootId ?? null,
      payload.firmwareVersion ?? "unknown",
    ],
  );

  return {
    device: mapDeviceRow(result.rows[0]),
  };
}

export async function listDevices(): Promise<DeviceSummary[]> {
  const result = await getDb().query<DeviceRow>(
    `select
       ${DEVICE_SELECT_COLUMNS}
     from devices
     order by updated_at desc, id asc`,
  );

  return result.rows.map(mapDeviceRow);
}

export async function listRecentEvents(limit = 12): Promise<MotionEventSummary[]> {
  const result = await getDb().query<MotionEventRow>(
    `select
       id,
       device_id,
       sequence,
       state,
       delta,
       event_timestamp,
       received_at,
       boot_id,
       firmware_version,
       hardware_id
     from motion_events
     order by received_at desc, id desc
     limit $1`,
    [limit],
  );

  return result.rows.map(mapMotionEventRow);
}

export async function listDeviceMotionEvents(args: {
  deviceId: string;
  startTimestamp: number;
  endTimestamp?: number;
}): Promise<MotionEventSummary[]> {
  const endTimestamp = args.endTimestamp ?? Date.now();
  const result = await getDb().query<MotionEventRow>(
    `select
       id,
       device_id,
       sequence,
       state,
       delta,
       event_timestamp,
       received_at,
       boot_id,
       firmware_version,
       hardware_id
     from motion_events
     where device_id = $1
       and event_timestamp >= $2
       and event_timestamp < $3
     order by event_timestamp asc, id asc`,
    [args.deviceId, args.startTimestamp, endTimestamp],
  );

  return result.rows.map(mapMotionEventRow);
}

export async function listDeviceMotionEventsByReceivedAt(args: {
  deviceId: string;
  startReceivedAt: string;
  endReceivedAt?: string;
}): Promise<MotionEventSummary[]> {
  const endReceivedAt = args.endReceivedAt ?? new Date().toISOString();
  const result = await getDb().query<MotionEventRow>(
    `select
       id,
       device_id,
       sequence,
       state,
       delta,
       event_timestamp,
       received_at,
       boot_id,
       firmware_version,
       hardware_id
     from motion_events
     where device_id = $1
       and received_at >= $2::timestamptz
       and received_at < $3::timestamptz
     order by received_at asc, event_timestamp asc, id asc`,
    [args.deviceId, args.startReceivedAt, endReceivedAt],
  );

  return result.rows.map(mapMotionEventRow);
}

export async function findLatestDeviceMotionEventBefore(args: {
  deviceId: string;
  beforeTimestamp: number;
}): Promise<MotionEventSummary | null> {
  const result = await getDb().query<MotionEventRow>(
    `select
       id,
       device_id,
       sequence,
       state,
       delta,
       event_timestamp,
       received_at,
       boot_id,
       firmware_version,
       hardware_id
     from motion_events
     where device_id = $1
       and event_timestamp < $2
     order by event_timestamp desc, id desc
     limit 1`,
    [args.deviceId, args.beforeTimestamp],
  );

  return result.rows[0] ? mapMotionEventRow(result.rows[0]) : null;
}

export async function findLatestDeviceMotionEventBeforeReceivedAt(args: {
  deviceId: string;
  beforeReceivedAt: string;
}): Promise<MotionEventSummary | null> {
  const result = await getDb().query<MotionEventRow>(
    `select
       id,
       device_id,
       sequence,
       state,
       delta,
       event_timestamp,
       received_at,
       boot_id,
       firmware_version,
       hardware_id
     from motion_events
     where device_id = $1
       and received_at < $2::timestamptz
     order by received_at desc, event_timestamp desc, id desc
     limit 1`,
    [args.deviceId, args.beforeReceivedAt],
  );

  return result.rows[0] ? mapMotionEventRow(result.rows[0]) : null;
}
