import { getDb } from "../db";
import type {
  BackfillBatchInput,
  BackfillBatchResult,
  DeviceSyncStateSummary,
} from "../motion";
import {
  DEVICE_SELECT_COLUMNS,
  type DeviceLogRow,
  type DeviceRow,
  type DeviceSyncStateRow,
  type MotionEventRow,
  mapDeviceLogRow,
  mapDeviceSyncStateRow,
  mapMotionEventRow,
} from "./shared";

export function shouldApplyBackfillMotionState(
  currentLastSeenAt: number,
  batchLastSeenAt: number,
  hasMotionRecord: boolean,
) {
  return hasMotionRecord && batchLastSeenAt >= currentLastSeenAt;
}

export async function getDeviceSyncState(deviceId: string): Promise<DeviceSyncStateSummary> {
  const result = await getDb().query<DeviceSyncStateRow>(
    `select
       device_id,
       last_acked_sequence,
       last_acked_boot_id,
       last_sync_completed_at,
       last_overflow_detected_at
     from device_sync_state
     where device_id = $1`,
    [deviceId],
  );

  if (!result.rows[0]) {
    return {
      deviceId,
      lastAckedSequence: 0,
      lastAckedBootId: null,
      lastSyncCompletedAt: null,
      lastOverflowDetectedAt: null,
    };
  }

  return mapDeviceSyncStateRow(result.rows[0]);
}

export async function recordBackfillBatch(
  input: BackfillBatchInput,
): Promise<BackfillBatchResult> {
  const client = await getDb().connect();

  try {
    await client.query("BEGIN");

    const maxTimestamp = input.records.reduce(
      (highest, record) => Math.max(highest, "timestamp" in record ? record.timestamp ?? 0 : 0),
      0,
    );
    const lastMotionRecord = [...input.records]
      .reverse()
      .find((record) => record.kind === "motion");
    const lastState = lastMotionRecord?.state ?? null;
    const lastDelta = lastMotionRecord?.delta ?? null;

    if (input.records.length > 0) {
      await client.query<DeviceRow>(
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
         values ($1, coalesce($2::text, 'still'), $3, $4, now(), $5, $6, $7, 'provisioned', 'idle', now())
         on conflict (id) do update
         set last_state = case
               when $2::text is null then devices.last_state
               when $3 >= devices.last_seen_at then $2::text
               else devices.last_state
             end,
             last_seen_at = greatest(devices.last_seen_at, excluded.last_seen_at),
             last_delta = case
               when $2::text is null then devices.last_delta
               when $3 >= devices.last_seen_at then coalesce($4::int, devices.last_delta)
               else devices.last_delta
             end,
             updated_at = now(),
             hardware_id = coalesce(excluded.hardware_id, devices.hardware_id),
             boot_id = coalesce(excluded.boot_id, devices.boot_id),
             firmware_version = coalesce(excluded.firmware_version, devices.firmware_version),
             provisioning_state = case
               when devices.provisioning_state in ('unassigned', 'assigned') then 'provisioned'
               else devices.provisioning_state
             end,
             last_event_received_at = now()
         returning
           ${DEVICE_SELECT_COLUMNS}`,
        [
          input.deviceId,
          lastState,
          maxTimestamp,
          lastDelta,
          lastMotionRecord?.hardwareId ?? input.records.at(-1)?.hardwareId ?? null,
          input.bootId ?? input.records.at(-1)?.bootId ?? null,
          input.records.at(-1)?.firmwareVersion ?? "unknown",
        ],
      );
    }

    const insertedEvents = [];
    const insertedLogs = [];

    for (const record of input.records) {
      if (record.kind === "motion") {
        const eventResult = await client.query<MotionEventRow>(
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
           on conflict (device_id, sequence) where sequence is not null do nothing
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
            input.deviceId,
            record.sequence,
            record.state,
            record.delta ?? null,
            record.timestamp,
            record.bootId ?? input.bootId ?? null,
            record.firmwareVersion ?? null,
            record.hardwareId ?? null,
          ],
        );

        if (eventResult.rows[0]) {
          insertedEvents.push(mapMotionEventRow(eventResult.rows[0]));
        }
        continue;
      }

      const logResult = await client.query<DeviceLogRow>(
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
         on conflict (device_id, sequence) where sequence is not null do nothing
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
          record.sequence,
          record.level,
          record.code,
          record.message,
          record.bootId ?? input.bootId ?? null,
          record.firmwareVersion ?? null,
          record.hardwareId ?? null,
          record.timestamp ?? null,
          record.metadata ?? null,
        ],
      );

      if (logResult.rows[0]) {
        insertedLogs.push(mapDeviceLogRow(logResult.rows[0]));
      }
    }

    const syncResult = await client.query<DeviceSyncStateRow>(
      `insert into device_sync_state (
         device_id,
         last_acked_sequence,
         last_acked_boot_id,
         last_sync_completed_at,
         last_overflow_detected_at,
         updated_at
       )
       values ($1, $2, $3, now(), $4, now())
       on conflict (device_id) do update
       set last_acked_sequence = greatest(device_sync_state.last_acked_sequence, excluded.last_acked_sequence),
           last_acked_boot_id = excluded.last_acked_boot_id,
           last_sync_completed_at = now(),
           last_overflow_detected_at = coalesce(excluded.last_overflow_detected_at, device_sync_state.last_overflow_detected_at),
           updated_at = now()
       returning
         device_id,
         last_acked_sequence,
         last_acked_boot_id,
         last_sync_completed_at,
         last_overflow_detected_at`,
      [
        input.deviceId,
        input.ackSequence,
        input.bootId ?? null,
        input.overflowDetectedAt ?? null,
      ],
    );

    await client.query("COMMIT");

    return {
      insertedEvents,
      insertedLogs,
      syncState: mapDeviceSyncStateRow(syncResult.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
