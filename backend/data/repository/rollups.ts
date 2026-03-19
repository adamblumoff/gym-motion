import type { PoolClient } from "pg";

import { getDb } from "../db";
import type { AnalyticsWindow, MotionEventSummary } from "../motion";
import { type MotionEventRow, mapMotionEventRow } from "./shared";

type Queryable = Pick<PoolClient, "query">;

type RollupDefinition = {
  tableName: "motion_rollups_hourly" | "motion_rollups_daily";
  bucketMs: number;
};

type MotionRollupRow = {
  device_id: string;
  bucket_start: string | number;
  movement_count: string | number;
  moving_seconds: string | number;
  updated_at: Date;
};

export type MotionRollupBucket = {
  deviceId: string;
  bucketStart: number;
  movementCount: number;
  movingSeconds: number;
  updatedAt: string;
};

const HOURLY_BUCKET_MS = 60 * 60 * 1000;
const DAILY_BUCKET_MS = 24 * 60 * 60 * 1000;

const ROLLUP_DEFINITIONS: RollupDefinition[] = [
  {
    tableName: "motion_rollups_hourly",
    bucketMs: HOURLY_BUCKET_MS,
  },
  {
    tableName: "motion_rollups_daily",
    bucketMs: DAILY_BUCKET_MS,
  },
];

function toSafeNumber(value: string | number) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(numericValue)) {
    throw new Error(`Value is not a safe integer: ${value}`);
  }

  return numericValue;
}

function floorBucketStart(timestamp: number, bucketMs: number) {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

function rangeEndBucketStart(rangeStart: number, rangeEndExclusive: number, bucketMs: number) {
  const terminalTimestamp =
    rangeEndExclusive > rangeStart ? rangeEndExclusive - 1 : rangeStart;
  return floorBucketStart(terminalTimestamp, bucketMs);
}

function addMovingDuration(
  bucketMap: Map<number, { movementCount: number; movingSeconds: number }>,
  bucketMs: number,
  windowStart: number,
  windowEnd: number,
  startTimestamp: number,
  endTimestamp: number,
) {
  const clampedStart = Math.max(startTimestamp, windowStart);
  const clampedEnd = Math.min(endTimestamp, windowEnd);

  if (clampedEnd <= clampedStart) {
    return;
  }

  let cursor = clampedStart;

  while (cursor < clampedEnd) {
    const bucketStart = floorBucketStart(cursor, bucketMs);
    const bucket = bucketMap.get(bucketStart) ?? {
      movementCount: 0,
      movingSeconds: 0,
    };
    const bucketEnd = bucketStart + bucketMs;
    const segmentEnd = Math.min(bucketEnd, clampedEnd);
    bucket.movingSeconds += Math.round((segmentEnd - cursor) / 1000);
    bucketMap.set(bucketStart, bucket);
    cursor = segmentEnd;
  }
}

function addMovementCount(
  bucketMap: Map<number, { movementCount: number; movingSeconds: number }>,
  bucketMs: number,
  windowStart: number,
  windowEnd: number,
  timestamp: number,
) {
  if (timestamp < windowStart || timestamp >= windowEnd) {
    return;
  }

  const bucketStart = floorBucketStart(timestamp, bucketMs);
  const bucket = bucketMap.get(bucketStart) ?? {
    movementCount: 0,
    movingSeconds: 0,
  };
  bucket.movementCount += 1;
  bucketMap.set(bucketStart, bucket);
}

function summarizeEventsWithinWindow(args: {
  bucketMs: number;
  windowStart: number;
  windowEnd: number;
  precedingState: MotionEventSummary["state"] | null;
  events: MotionEventSummary[];
}) {
  const bucketMap = new Map<number, { movementCount: number; movingSeconds: number }>();
  let currentState = args.precedingState ?? "still";
  let currentTimestamp = args.windowStart;

  for (const event of args.events) {
    const eventTimestamp = event.eventTimestamp;

    if (currentState === "moving" && eventTimestamp > currentTimestamp) {
      addMovingDuration(
        bucketMap,
        args.bucketMs,
        args.windowStart,
        args.windowEnd,
        currentTimestamp,
        eventTimestamp,
      );
    }

    if (event.state === "moving" && currentState !== "moving") {
      addMovementCount(
        bucketMap,
        args.bucketMs,
        args.windowStart,
        args.windowEnd,
        eventTimestamp,
      );
    }

    currentState = event.state;
    currentTimestamp = eventTimestamp;
  }

  return bucketMap;
}

async function findLatestEventBefore(
  client: Queryable,
  deviceId: string,
  beforeTimestamp: number,
) {
  const result = await client.query<MotionEventRow>(
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
    [deviceId, beforeTimestamp],
  );

  return result.rows[0] ? mapMotionEventRow(result.rows[0]) : null;
}

async function findFirstEventAtOrAfter(
  client: Queryable,
  deviceId: string,
  fromTimestamp: number,
) {
  const result = await client.query<MotionEventRow>(
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
     order by event_timestamp asc, id asc
     limit 1`,
    [deviceId, fromTimestamp],
  );

  return result.rows[0] ? mapMotionEventRow(result.rows[0]) : null;
}

async function listEventsBetween(
  client: Queryable,
  deviceId: string,
  startTimestamp: number,
  endTimestampExclusive: number,
) {
  const result = await client.query<MotionEventRow>(
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
    [deviceId, startTimestamp, endTimestampExclusive],
  );

  return result.rows.map(mapMotionEventRow);
}

async function replaceRollupBuckets(args: {
  client: Queryable;
  deviceId: string;
  definition: RollupDefinition;
  rangeStart: number;
  rangeEndExclusive: number;
}) {
  const firstBucketStart = floorBucketStart(args.rangeStart, args.definition.bucketMs);
  const lastBucketStart = rangeEndBucketStart(
    args.rangeStart,
    args.rangeEndExclusive,
    args.definition.bucketMs,
  );
  const windowStart = firstBucketStart;
  const windowEnd = lastBucketStart + args.definition.bucketMs;

  await args.client.query(
    `delete from ${args.definition.tableName}
     where device_id = $1
       and bucket_start >= $2
       and bucket_start <= $3`,
    [args.deviceId, firstBucketStart, lastBucketStart],
  );

  const [precedingEvent, inWindowEvents, trailingEvent] = await Promise.all([
    findLatestEventBefore(args.client, args.deviceId, windowStart),
    listEventsBetween(args.client, args.deviceId, windowStart, windowEnd),
    findFirstEventAtOrAfter(args.client, args.deviceId, windowEnd),
  ]);

  const events = trailingEvent ? [...inWindowEvents, trailingEvent] : inWindowEvents;
  const bucketMap = summarizeEventsWithinWindow({
    bucketMs: args.definition.bucketMs,
    windowStart,
    windowEnd,
    precedingState: precedingEvent?.state ?? null,
    events,
  });

  for (const [bucketStart, summary] of bucketMap.entries()) {
    if (summary.movementCount === 0 && summary.movingSeconds === 0) {
      continue;
    }

    await args.client.query(
      `insert into ${args.definition.tableName} (
         device_id,
         bucket_start,
         movement_count,
         moving_seconds,
         updated_at
       )
       values ($1, $2, $3, $4, now())`,
      [
        args.deviceId,
        bucketStart,
        summary.movementCount,
        summary.movingSeconds,
      ],
    );
  }
}

export async function refreshMotionRollupsForDeviceRange(args: {
  client: Queryable;
  deviceId: string;
  rangeStart: number;
  rangeEndExclusive: number;
}) {
  for (const definition of ROLLUP_DEFINITIONS) {
    await replaceRollupBuckets({
      client: args.client,
      deviceId: args.deviceId,
      definition,
      rangeStart: args.rangeStart,
      rangeEndExclusive: args.rangeEndExclusive,
    });
  }
}

function summarizeWholeTimeline(
  bucketMs: number,
  events: MotionEventSummary[],
) {
  const bucketMap = new Map<number, { movementCount: number; movingSeconds: number }>();
  let currentState: MotionEventSummary["state"] = "still";
  let currentTimestamp = 0;

  for (const event of events) {
    if (currentState === "moving" && event.eventTimestamp > currentTimestamp) {
      addMovingDuration(
        bucketMap,
        bucketMs,
        floorBucketStart(events[0]!.eventTimestamp, bucketMs),
        Number.MAX_SAFE_INTEGER,
        currentTimestamp,
        event.eventTimestamp,
      );
    }

    if (event.state === "moving" && currentState !== "moving") {
      addMovementCount(
        bucketMap,
        bucketMs,
        floorBucketStart(events[0]!.eventTimestamp, bucketMs),
        Number.MAX_SAFE_INTEGER,
        event.eventTimestamp,
      );
    }

    currentState = event.state;
    currentTimestamp = event.eventTimestamp;
  }

  return bucketMap;
}

async function insertContributionMap(args: {
  client: Queryable;
  deviceId: string;
  definition: RollupDefinition;
  bucketMap: Map<number, { movementCount: number; movingSeconds: number }>;
}) {
  for (const [bucketStart, summary] of args.bucketMap.entries()) {
    if (summary.movementCount === 0 && summary.movingSeconds === 0) {
      continue;
    }

    await args.client.query(
      `insert into ${args.definition.tableName} (
         device_id,
         bucket_start,
         movement_count,
         moving_seconds,
         updated_at
       )
       values ($1, $2, $3, $4, now())`,
      [args.deviceId, bucketStart, summary.movementCount, summary.movingSeconds],
    );
  }
}

export async function rebuildMotionRollups(client: Queryable, deviceId?: string) {
  if (deviceId) {
    for (const definition of ROLLUP_DEFINITIONS) {
      await client.query(`delete from ${definition.tableName} where device_id = $1`, [deviceId]);
    }
  } else {
    for (const definition of ROLLUP_DEFINITIONS) {
      await client.query(`truncate table ${definition.tableName}`);
    }
  }

  const result = await client.query<MotionEventRow>(
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
     ${deviceId ? "where device_id = $1" : ""}
     order by device_id asc, event_timestamp asc, id asc`,
    deviceId ? [deviceId] : [],
  );

  const eventsByDevice = new Map<string, MotionEventSummary[]>();

  for (const row of result.rows) {
    const event = mapMotionEventRow(row);
    const current = eventsByDevice.get(event.deviceId) ?? [];
    current.push(event);
    eventsByDevice.set(event.deviceId, current);
  }

  for (const [currentDeviceId, events] of eventsByDevice.entries()) {
    for (const definition of ROLLUP_DEFINITIONS) {
      await insertContributionMap({
        client,
        deviceId: currentDeviceId,
        definition,
        bucketMap: summarizeWholeTimeline(definition.bucketMs, events),
      });
    }
  }
}

function mapRollupRow(row: MotionRollupRow): MotionRollupBucket {
  return {
    deviceId: row.device_id,
    bucketStart: toSafeNumber(row.bucket_start),
    movementCount: toSafeNumber(row.movement_count),
    movingSeconds: toSafeNumber(row.moving_seconds),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listMotionRollupBuckets(args: {
  deviceId: string;
  window: AnalyticsWindow;
  startBucket: number;
  endBucketExclusive: number;
}) {
  const definition =
    args.window === "24h"
      ? ROLLUP_DEFINITIONS[0]
      : ROLLUP_DEFINITIONS[1];
  const result = await getDb().query<MotionRollupRow>(
    `select
       device_id,
       bucket_start,
       movement_count,
       moving_seconds,
       updated_at
     from ${definition.tableName}
     where device_id = $1
       and bucket_start >= $2
       and bucket_start < $3
     order by bucket_start asc`,
    [args.deviceId, args.startBucket, args.endBucketExclusive],
  );

  return result.rows.map(mapRollupRow);
}
