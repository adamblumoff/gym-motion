import { getDb } from "../db";
import type {
  DeviceActivitySummary,
  DeviceLogInput,
  DeviceLogSummary,
} from "../motion";
import {
  type DeviceLogRow,
  type MotionEventRow,
  mapDeviceLogRow,
  mapDeviceLogToActivity,
  mapMotionEventRow,
  mapMotionEventToActivity,
  sortActivities,
} from "./shared";

function sequenceConflictClause() {
  return "(device_id, coalesce(boot_id, ''), sequence) where sequence is not null";
}

export async function recordDeviceLog(input: DeviceLogInput): Promise<DeviceLogSummary> {
  const result = await getDb().query<DeviceLogRow>(
    `insert into device_logs (
       device_id,
       sequence,
       level,
       code,
       message,
       boot_id,
       firmware_version,
       hardware_id,
       device_timestamp,
       metadata
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict ${sequenceConflictClause()} do nothing
     returning
       id,
       device_id,
       sequence,
       level,
       code,
       message,
       boot_id,
       firmware_version,
       hardware_id,
       device_timestamp,
       metadata,
       received_at`,
    [
      input.deviceId,
      input.sequence ?? null,
      input.level,
      input.code,
      input.message,
      input.bootId ?? null,
      input.firmwareVersion ?? null,
      input.hardwareId ?? null,
      input.timestamp ?? null,
      input.metadata ?? null,
    ],
  );

  if (result.rows[0]) {
    return mapDeviceLogRow(result.rows[0]);
  }

  if (input.sequence === undefined) {
    throw new Error("Device log insert returned no row.");
  }

  const existing = await getDb().query<DeviceLogRow>(
    `select
       id,
       device_id,
       sequence,
       level,
       code,
       message,
       boot_id,
       firmware_version,
       hardware_id,
       device_timestamp,
       metadata,
       received_at
     from device_logs
     where device_id = $1
       and coalesce(boot_id, '') = coalesce($2, '')
       and sequence = $3
     limit 1`,
    [input.deviceId, input.bootId ?? null, input.sequence],
  );

  if (!existing.rows[0]) {
    throw new Error("Device log insert conflict returned no existing row.");
  }

  return mapDeviceLogRow(existing.rows[0]);
}

export async function listDeviceLogs(options?: {
  deviceId?: string | null;
  limit?: number;
}): Promise<DeviceLogSummary[]> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 250);

  const result = options?.deviceId
    ? await getDb().query<DeviceLogRow>(
        `select
           id,
           device_id,
           sequence,
           level,
           code,
           message,
           boot_id,
           firmware_version,
           hardware_id,
           device_timestamp,
           metadata,
           received_at
         from device_logs
         where device_id = $1
         order by received_at desc, id desc
         limit $2`,
        [options.deviceId, limit],
      )
    : await getDb().query<DeviceLogRow>(
        `select
           id,
           device_id,
           sequence,
           level,
           code,
           message,
           boot_id,
           firmware_version,
           hardware_id,
           device_timestamp,
           metadata,
           received_at
         from device_logs
         order by received_at desc, id desc
         limit $1`,
        [limit],
      );

  return result.rows.map(mapDeviceLogRow);
}

export async function listDeviceActivity(options: {
  deviceId: string;
  limit?: number;
}): Promise<DeviceActivitySummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 250);
  const [events, logs] = await Promise.all([
    getDb().query<MotionEventRow>(
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
       order by received_at desc, id desc
       limit $2`,
      [options.deviceId, limit],
    ),
    getDb().query<DeviceLogRow>(
      `select
         id,
         device_id,
         sequence,
         level,
         code,
         message,
         boot_id,
         firmware_version,
         hardware_id,
         device_timestamp,
         metadata,
         received_at
       from device_logs
       where device_id = $1
       order by received_at desc, id desc
       limit $2`,
      [options.deviceId, limit],
    ),
  ]);

  return sortActivities(
    [
      ...events.rows.map(mapMotionEventRow).map(mapMotionEventToActivity),
      ...logs.rows.map(mapDeviceLogRow).map(mapDeviceLogToActivity),
    ],
    limit,
  );
}

export async function listRecentActivity(limit = 30): Promise<DeviceActivitySummary[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), 250);
  const result = await getDb().query<
    | (MotionEventRow & { activity_kind: "motion" })
    | (DeviceLogRow & { activity_kind: "lifecycle" })
  >(
    `select *
     from (
       select
         'motion' as activity_kind,
         id,
         device_id,
         sequence,
         state,
         delta,
         event_timestamp,
         received_at,
         boot_id,
         firmware_version,
         hardware_id,
         null::text as level,
         null::text as code,
         null::text as message,
         null::bigint as device_timestamp,
         null::jsonb as metadata
       from motion_events
       union all
       select
         'lifecycle' as activity_kind,
         id,
         device_id,
         sequence,
         null::text as state,
         null::integer as delta,
         device_timestamp as event_timestamp,
         received_at,
         boot_id,
         firmware_version,
         hardware_id,
         level,
         code,
         message,
         device_timestamp,
         metadata
       from device_logs
     ) combined
     order by received_at desc, id desc
     limit $1`,
    [cappedLimit],
  );

  return sortActivities(
    result.rows.map((row) =>
      row.activity_kind === "motion"
        ? mapMotionEventToActivity(mapMotionEventRow(row as MotionEventRow))
        : mapDeviceLogToActivity(mapDeviceLogRow(row as DeviceLogRow)),
    ),
    cappedLimit,
  );
}
