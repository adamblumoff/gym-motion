import { getDb } from "../db";
import type {
  BackfillBatchInput,
  BackfillBatchResult,
  DeviceSyncStateSummary,
  FirmwareHistorySyncStateSummary,
} from "../motion";
import { getMotionEventTimelineTimestamp } from "../motion";
import {
  DEVICE_SELECT_COLUMNS,
  type DeviceLogRow,
  type DeviceRow,
  type DeviceSyncStateRow,
  type FirmwareHistorySyncStateRow,
  type MotionEventRow,
  mapDeviceLogRow,
  mapDeviceSyncStateRow,
  mapFirmwareHistorySyncStateRow,
  mapMotionEventRow,
} from "./shared";
import { refreshMotionRollupsForDeviceRange } from "./rollups";

function normalizeBootId(bootId: string | null | undefined) {
  return bootId ?? "";
}

function sequenceConflictClause() {
  return "(device_id, coalesce(boot_id, ''), sequence) where sequence is not null";
}

function buildBackfillReceivedAtIso(args: {
  anchorReceivedAtMs: number;
  anchorDeviceTimestamp: number | string | null;
  recordTimestamp: number | string | null;
}) {
  const { anchorReceivedAtMs } = args;
  const anchorDeviceTimestamp =
    args.anchorDeviceTimestamp === null ? null : Number(args.anchorDeviceTimestamp);
  const recordTimestamp = args.recordTimestamp === null ? null : Number(args.recordTimestamp);

  if (
    anchorDeviceTimestamp === null ||
    recordTimestamp === null ||
    !Number.isFinite(anchorDeviceTimestamp) ||
    !Number.isFinite(recordTimestamp)
  ) {
    return new Date(anchorReceivedAtMs).toISOString();
  }

  const offsetMs = anchorDeviceTimestamp - recordTimestamp;
  return new Date(anchorReceivedAtMs - Math.max(0, offsetMs)).toISOString();
}

export function shouldApplyBackfillMotionState(
  hasLiveContact: boolean,
  hasMotionRecord: boolean,
) {
  return !hasLiveContact && hasMotionRecord;
}

type BackfillExpectedKinds = {
  motion: boolean;
  log: boolean;
};

function buildExpectedBackfillSequenceKinds(args: {
  records: BackfillBatchInput["records"];
  previousAckSequence: number;
  requestedAckSequence: number;
}) {
  const expectedBySequence = new Map<number, BackfillExpectedKinds>();

  for (const record of args.records) {
    if (
      record.sequence <= args.previousAckSequence ||
      record.sequence > args.requestedAckSequence
    ) {
      continue;
    }

    const expected = expectedBySequence.get(record.sequence) ?? {
      motion: false,
      log: false,
    };

    if (record.kind === "motion") {
      expected.motion = true;
    } else {
      expected.log = true;
    }

    expectedBySequence.set(record.sequence, expected);
  }

  return expectedBySequence;
}

export function computeProvenBackfillAckSequence(args: {
  previousAckSequence: number;
  requestedAckSequence: number;
  records: BackfillBatchInput["records"];
  durableMotionSequences: Iterable<number>;
  durableLogSequences: Iterable<number>;
}) {
  const expectedBySequence = buildExpectedBackfillSequenceKinds({
    records: args.records,
    previousAckSequence: args.previousAckSequence,
    requestedAckSequence: args.requestedAckSequence,
  });
  const durableMotionSequences = new Set(args.durableMotionSequences);
  const durableLogSequences = new Set(args.durableLogSequences);
  let provenAckSequence = args.previousAckSequence;

  while (provenAckSequence < args.requestedAckSequence) {
    const nextSequence = provenAckSequence + 1;
    const expected = expectedBySequence.get(nextSequence);

    if (!expected) {
      break;
    }

    if (expected.motion && !durableMotionSequences.has(nextSequence)) {
      break;
    }

    if (expected.log && !durableLogSequences.has(nextSequence)) {
      break;
    }

    provenAckSequence = nextSequence;
  }

  return provenAckSequence;
}

export async function getDeviceSyncState(
  deviceId: string,
  bootId?: string | null,
): Promise<DeviceSyncStateSummary> {
  const result = await getDb().query<DeviceSyncStateRow>(
    `select
       device_id,
       boot_id,
       last_acked_sequence,
       last_acked_boot_id,
       last_sync_completed_at,
       last_overflow_detected_at
     from device_sync_state
     where device_id = $1
       and ($2::text is null or boot_id = $2)
     order by updated_at desc, boot_id desc
     limit 1`,
    [deviceId, bootId === undefined ? null : normalizeBootId(bootId)],
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

export async function getFirmwareHistorySyncState(
  deviceId: string,
): Promise<FirmwareHistorySyncStateSummary> {
  const result = await getDb().query<FirmwareHistorySyncStateRow>(
    `select
       device_id,
       last_acked_history_sequence,
       last_history_sync_completed_at,
       last_history_overflow_detected_at
     from firmware_history_sync_state
     where device_id = $1
     limit 1`,
    [deviceId],
  );

  if (!result.rows[0]) {
    return {
      deviceId,
      lastAckedHistorySequence: 0,
      lastHistorySyncCompletedAt: null,
      lastHistoryOverflowDetectedAt: null,
    };
  }

  return mapFirmwareHistorySyncStateRow(result.rows[0]);
}

export function durableBackfillRecordKey(args: {
  kind: BackfillBatchInput["records"][number]["kind"];
  bootId: string | null | undefined;
  sequence: number;
}) {
  return `${args.kind}:${normalizeBootId(args.bootId)}:${args.sequence}`;
}

export function computeProvenFirmwareHistoryAckSequence(args: {
  previousAckSequence: number;
  records: BackfillBatchInput["records"];
  durableRecordKeys: Iterable<string>;
  defaultBootId?: string | null;
}) {
  const durableRecordKeys = new Set(args.durableRecordKeys);
  let provenAckSequence = args.previousAckSequence;

  for (const record of args.records) {
    const durableKey = durableBackfillRecordKey({
      kind: record.kind,
      bootId: record.bootId ?? args.defaultBootId ?? null,
      sequence: record.sequence,
    });

    if (!durableRecordKeys.has(durableKey)) {
      break;
    }

    provenAckSequence = Math.max(provenAckSequence, record.sequence);
  }

  return provenAckSequence;
}

export async function recordBackfillBatch(
  input: BackfillBatchInput,
): Promise<BackfillBatchResult> {
  const client = await getDb().connect();
  const activeBootId = input.bootId ?? input.records.at(-1)?.bootId ?? null;
  const normalizedActiveBootId = normalizeBootId(activeBootId);

  try {
    await client.query("BEGIN");

    const existingBootSyncStateResult = await client.query<{
      last_acked_sequence: string | number;
    }>(
      `select last_acked_sequence
       from device_sync_state
       where device_id = $1
         and boot_id = $2
       limit 1`,
      [input.deviceId, normalizedActiveBootId],
    );
    const previousAckSequence = existingBootSyncStateResult.rows[0]
      ? Number(existingBootSyncStateResult.rows[0].last_acked_sequence)
      : 0;
    const existingFirmwareHistorySyncStateResult = await client.query<{
      last_acked_history_sequence: string | number;
    }>(
      `select last_acked_history_sequence
       from firmware_history_sync_state
       where device_id = $1
       limit 1`,
      [input.deviceId],
    );
    const previousHistoryAckSequence = existingFirmwareHistorySyncStateResult.rows[0]
      ? Number(existingFirmwareHistorySyncStateResult.rows[0].last_acked_history_sequence)
      : 0;

    const maxTimestamp = input.records.reduce(
      (highest, record) => Math.max(highest, "timestamp" in record ? record.timestamp ?? 0 : 0),
      0,
    );
    const lastMotionRecord = [...input.records]
      .reverse()
      .find((record) => record.kind === "motion");
    const lastState = lastMotionRecord?.state ?? null;
    const lastDelta = lastMotionRecord?.delta ?? null;
    const existingDeviceResult = await client.query<{
      last_event_received_at: Date | null;
      last_heartbeat_at: Date | null;
      last_seen_at: number | null;
      boot_id: string | null;
    }>(
      `select
         last_event_received_at,
         last_heartbeat_at,
         last_seen_at,
         boot_id
       from devices
       where id = $1
       limit 1`,
      [input.deviceId],
    );
    const existingDevice = existingDeviceResult.rows[0] ?? null;
    const hasLiveContact = Boolean(
      existingDevice?.last_event_received_at ?? existingDevice?.last_heartbeat_at,
    );
    const anchorReceivedAtMs =
      (existingDevice?.last_event_received_at ?? existingDevice?.last_heartbeat_at)?.getTime() ??
      Date.now();
    const shouldSeedMotionState = shouldApplyBackfillMotionState(
      hasLiveContact,
      Boolean(lastMotionRecord),
    );

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
       values ($1, coalesce($2::text, 'still'), $3, $4, now(), $5, $6, $7, 'provisioned', 'idle', $8)
       on conflict (id) do update
       set last_state = case
             when $9::boolean then coalesce($2::text, devices.last_state)
             else devices.last_state
           end,
           last_seen_at = case
             when $9::boolean then greatest(devices.last_seen_at, excluded.last_seen_at)
             else devices.last_seen_at
           end,
           last_delta = case
             when $9::boolean then coalesce($4::int, devices.last_delta)
             else devices.last_delta
           end,
           updated_at = now(),
           hardware_id = coalesce(excluded.hardware_id, devices.hardware_id),
           boot_id = coalesce(excluded.boot_id, devices.boot_id),
           firmware_version = coalesce(excluded.firmware_version, devices.firmware_version),
           provisioning_state = case
             when devices.provisioning_state in ('unassigned', 'assigned') then 'provisioned'
             else devices.provisioning_state
           end
       returning
         ${DEVICE_SELECT_COLUMNS}`,
      [
        input.deviceId,
        shouldSeedMotionState ? lastState : null,
        shouldSeedMotionState ? maxTimestamp : 0,
        shouldSeedMotionState ? lastDelta : null,
        lastMotionRecord?.hardwareId ?? input.records.at(-1)?.hardwareId ?? null,
        input.bootId ?? input.records.at(-1)?.bootId ?? null,
        input.records.at(-1)?.firmwareVersion ?? "unknown",
        null,
        shouldSeedMotionState,
      ],
    );

    const insertedEvents = [];
    const insertedLogs = [];
    const maxBatchTimestamp = input.records.reduce((highest, record) => {
      const recordTimestamp = "timestamp" in record ? record.timestamp ?? null : null;
      return recordTimestamp === null ? highest : Math.max(highest, recordTimestamp);
    }, Number.NEGATIVE_INFINITY);
    const normalizedMaxBatchTimestamp = Number.isFinite(maxBatchTimestamp) ? maxBatchTimestamp : null;
    const anchorDeviceTimestamp =
      existingDevice?.boot_id === normalizedActiveBootId && existingDevice.last_seen_at !== null
        ? Number(existingDevice.last_seen_at)
        : normalizedMaxBatchTimestamp;
    const motionRecords = input.records
      .filter((record): record is Extract<BackfillBatchInput["records"][number], { kind: "motion" }> =>
        record.kind === "motion",
      )
      .map((record) => ({
        sequence: record.sequence,
        state: record.state,
        delta: record.delta ?? null,
        timestamp: record.timestamp,
        boot_id: record.bootId ?? activeBootId ?? null,
        firmware_version: record.firmwareVersion ?? null,
        hardware_id: record.hardwareId ?? null,
        received_at: buildBackfillReceivedAtIso({
          anchorReceivedAtMs,
          anchorDeviceTimestamp,
          recordTimestamp: record.timestamp,
        }),
      }));
    const logRecords = input.records
      .filter((record): record is Extract<BackfillBatchInput["records"][number], { kind: "node-log" }> =>
        record.kind === "node-log",
      )
      .map((record) => ({
        sequence: record.sequence,
        level: record.level,
        code: record.code,
        message: record.message,
        timestamp: record.timestamp ?? null,
        boot_id: record.bootId ?? activeBootId ?? null,
        firmware_version: record.firmwareVersion ?? null,
        hardware_id: record.hardwareId ?? null,
        metadata: record.metadata ?? null,
        received_at: buildBackfillReceivedAtIso({
          anchorReceivedAtMs,
          anchorDeviceTimestamp,
          recordTimestamp: record.timestamp ?? null,
        }),
      }));

    if (motionRecords.length > 0) {
      const eventResult = await client.query<MotionEventRow>(
        `insert into motion_events (
           device_id,
           sequence,
           state,
           delta,
           event_timestamp,
           received_at,
           boot_id,
           firmware_version,
           hardware_id
         )
         select
           $1,
           records.sequence,
           records.state,
           records.delta,
           records.timestamp,
           records.received_at::timestamptz,
           records.boot_id,
           records.firmware_version,
           records.hardware_id
         from jsonb_to_recordset($2::jsonb) as records(
           sequence bigint,
           state text,
           delta integer,
           timestamp bigint,
           received_at text,
           boot_id text,
           firmware_version text,
           hardware_id text
         )
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
        [input.deviceId, JSON.stringify(motionRecords)],
      );

      insertedEvents.push(...eventResult.rows.map(mapMotionEventRow));
    }

    if (logRecords.length > 0) {
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
           received_at,
           metadata
         )
         select
           $1,
           records.sequence,
           records.level,
           records.code,
           records.message,
           records.boot_id,
           records.firmware_version,
           records.hardware_id,
           records.timestamp,
           records.received_at::timestamptz,
           records.metadata
         from jsonb_to_recordset($2::jsonb) as records(
           sequence bigint,
           level text,
           code text,
           message text,
           timestamp bigint,
           received_at text,
           boot_id text,
           firmware_version text,
           hardware_id text,
           metadata jsonb
         )
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
        [input.deviceId, JSON.stringify(logRecords)],
      );

      insertedLogs.push(...logResult.rows.map(mapDeviceLogRow));
    }

    if (motionRecords.length > 0) {
      const motionReceivedAtTimestamps = motionRecords
        .map((record) => getMotionEventTimelineTimestamp({
          receivedAt: record.received_at,
        }))
        .filter((timestamp) => Number.isFinite(timestamp));

      if (motionReceivedAtTimestamps.length > 0) {
        const rangeStart = Math.min(...motionReceivedAtTimestamps);
        const rangeEndExclusive = Math.max(...motionReceivedAtTimestamps) + 1;

        await refreshMotionRollupsForDeviceRange({
          client,
          deviceId: input.deviceId,
          rangeStart,
          rangeEndExclusive,
        });
      }
    }

    const expectedBySequence = buildExpectedBackfillSequenceKinds({
      records: input.records,
      previousAckSequence,
      requestedAckSequence: input.ackSequence,
    });
    const expectedMotionSequences = [...expectedBySequence.entries()]
      .filter(([, expected]) => expected.motion)
      .map(([sequence]) => sequence);
    const expectedLogSequences = [...expectedBySequence.entries()]
      .filter(([, expected]) => expected.log)
      .map(([sequence]) => sequence);

    const durableMotionSequenceRows =
      expectedMotionSequences.length > 0
        ? await client.query<{ sequence: string | number }>(
            `select sequence
             from motion_events
             where device_id = $1
               and coalesce(boot_id, '') = $2
               and sequence = any($3::bigint[])`,
            [input.deviceId, normalizedActiveBootId, expectedMotionSequences],
          )
        : { rows: [] };
    const durableLogSequenceRows =
      expectedLogSequences.length > 0
        ? await client.query<{ sequence: string | number }>(
            `select sequence
             from device_logs
             where device_id = $1
               and coalesce(boot_id, '') = $2
               and sequence = any($3::bigint[])`,
            [input.deviceId, normalizedActiveBootId, expectedLogSequences],
          )
        : { rows: [] };
    const provenAckSequence = computeProvenBackfillAckSequence({
      previousAckSequence,
      requestedAckSequence: input.ackSequence,
      records: input.records,
      durableMotionSequences: durableMotionSequenceRows.rows.map((row) => Number(row.sequence)),
      durableLogSequences: durableLogSequenceRows.rows.map((row) => Number(row.sequence)),
    });
    const durableMotionRecords =
      motionRecords.length > 0
        ? await client.query<{ sequence: string | number; boot_id: string | null }>(
            `select distinct records.sequence, records.boot_id
             from jsonb_to_recordset($2::jsonb) as records(
               sequence bigint,
               boot_id text
             )
             join motion_events events
               on events.device_id = $1
              and events.sequence = records.sequence
              and coalesce(events.boot_id, '') = coalesce(records.boot_id, '')`,
            [input.deviceId, JSON.stringify(motionRecords)],
          )
        : { rows: [] };
    const durableLogRecords =
      logRecords.length > 0
        ? await client.query<{ sequence: string | number; boot_id: string | null }>(
            `select distinct records.sequence, records.boot_id
             from jsonb_to_recordset($2::jsonb) as records(
               sequence bigint,
               boot_id text
             )
             join device_logs logs
               on logs.device_id = $1
              and logs.sequence = records.sequence
              and coalesce(logs.boot_id, '') = coalesce(records.boot_id, '')`,
            [input.deviceId, JSON.stringify(logRecords)],
          )
        : { rows: [] };
    const provenHistoryAckSequence = computeProvenFirmwareHistoryAckSequence({
      previousAckSequence: previousHistoryAckSequence,
      records: input.records,
      defaultBootId: activeBootId ?? null,
      durableRecordKeys: [
        ...durableMotionRecords.rows.map((row) =>
          durableBackfillRecordKey({
            kind: "motion",
            bootId: row.boot_id,
            sequence: Number(row.sequence),
          }),
        ),
        ...durableLogRecords.rows.map((row) =>
          durableBackfillRecordKey({
            kind: "node-log",
            bootId: row.boot_id,
            sequence: Number(row.sequence),
          }),
        ),
      ],
    });

    const syncResult = await client.query<DeviceSyncStateRow>(
      `insert into device_sync_state (
         device_id,
         boot_id,
         last_acked_sequence,
         last_acked_boot_id,
         last_sync_completed_at,
         last_overflow_detected_at,
         updated_at
       )
       values ($1, $2, $3, $4, now(), $5, now())
       on conflict (device_id, boot_id) do update
       set last_acked_sequence = excluded.last_acked_sequence,
           last_acked_boot_id = excluded.last_acked_boot_id,
           last_sync_completed_at = now(),
           last_overflow_detected_at = coalesce(excluded.last_overflow_detected_at, device_sync_state.last_overflow_detected_at),
           updated_at = now()
       returning
         device_id,
         boot_id,
         last_acked_sequence,
         last_acked_boot_id,
         last_sync_completed_at,
         last_overflow_detected_at`,
       [
        input.deviceId,
        normalizedActiveBootId,
        provenAckSequence,
        activeBootId ?? null,
        input.overflowDetectedAt ?? null,
      ],
    );
    const historySyncResult = await client.query<FirmwareHistorySyncStateRow>(
      `insert into firmware_history_sync_state (
         device_id,
         last_acked_history_sequence,
         last_history_sync_completed_at,
         last_history_overflow_detected_at,
         updated_at
       )
       values ($1, $2, now(), $3, now())
       on conflict (device_id) do update
       set last_acked_history_sequence = excluded.last_acked_history_sequence,
           last_history_sync_completed_at = now(),
           last_history_overflow_detected_at = coalesce(
             excluded.last_history_overflow_detected_at,
             firmware_history_sync_state.last_history_overflow_detected_at
           ),
           updated_at = now()
       returning
         device_id,
         last_acked_history_sequence,
         last_history_sync_completed_at,
         last_history_overflow_detected_at`,
      [input.deviceId, provenHistoryAckSequence, input.overflowDetectedAt ?? null],
    );

    await client.query("COMMIT");

    return {
      insertedEvents,
      insertedLogs,
      syncState: mapDeviceSyncStateRow(syncResult.rows[0]),
      historySyncState: mapFirmwareHistorySyncStateRow(historySyncResult.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
