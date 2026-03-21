import type { PoolClient } from "pg";

import { getDb } from "../db";
import { getMotionEventTimelineTimestamp, type AnalyticsWindow, type MotionEventSummary } from "../motion";
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
const NEGATIVE_ROLLUP_AVAILABILITY_TTL_MS = 5_000;

type MotionRollupAvailabilityCache = {
  available: boolean;
  checkedAtMs: number;
};

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

let motionRollupAvailabilityCache: MotionRollupAvailabilityCache | null = null;

function isMissingRelationError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "42P01"
  );
}

async function queryMotionRollupAvailability(client: Queryable) {
  const result = await client.query<{
    hourly_name: string | null;
    daily_name: string | null;
  }>(
    `select
       to_regclass('public.motion_rollups_hourly') as hourly_name,
       to_regclass('public.motion_rollups_daily') as daily_name`,
  );
  const row = result.rows[0];

  return Boolean(row?.hourly_name && row.daily_name);
}

export async function hasMotionRollupTables(client?: Queryable) {
  if (motionRollupAvailabilityCache?.available) {
    return true;
  }

  const nowMs = Date.now();
  if (
    motionRollupAvailabilityCache &&
    !motionRollupAvailabilityCache.available &&
    nowMs - motionRollupAvailabilityCache.checkedAtMs < NEGATIVE_ROLLUP_AVAILABILITY_TTL_MS
  ) {
    return false;
  }

  try {
    const available = await queryMotionRollupAvailability(client ?? getDb());
    const previousAvailability = motionRollupAvailabilityCache?.available;
    motionRollupAvailabilityCache = {
      available,
      checkedAtMs: nowMs,
    };

    if (available && previousAvailability === false) {
      console.warn(
        "[runtime] detected motion rollup tables; enabling rollup-backed analytics without restarting.",
      );
    }

    return available;
  } catch (error) {
    if (isMissingRelationError(error)) {
      motionRollupAvailabilityCache = {
        available: false,
        checkedAtMs: nowMs,
      };
      return false;
    }

    throw error;
  }
}

export function resetMotionRollupAvailabilityCacheForTests() {
  motionRollupAvailabilityCache = null;
}

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
    const eventTimestamp = getMotionEventTimelineTimestamp(event);

    if (!Number.isFinite(eventTimestamp)) {
      continue;
    }

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
       and received_at < to_timestamp($2::double precision / 1000.0)
     order by received_at desc, id desc
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
       and received_at >= to_timestamp($2::double precision / 1000.0)
     order by received_at asc, id asc
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
       and received_at >= to_timestamp($2::double precision / 1000.0)
       and received_at < to_timestamp($3::double precision / 1000.0)
     order by received_at asc, id asc`,
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

  const precedingEvent = await findLatestEventBefore(args.client, args.deviceId, windowStart);
  const inWindowEvents = await listEventsBetween(args.client, args.deviceId, windowStart, windowEnd);
  const trailingEvent = await findFirstEventAtOrAfter(args.client, args.deviceId, windowEnd);

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
  if (!(await hasMotionRollupTables(args.client))) {
    return;
  }

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
    const eventTimestamp = getMotionEventTimelineTimestamp(event);

    if (!Number.isFinite(eventTimestamp)) {
      continue;
    }

    if (currentState === "moving" && eventTimestamp > currentTimestamp) {
      addMovingDuration(
        bucketMap,
        bucketMs,
        floorBucketStart(getMotionEventTimelineTimestamp(events[0]!), bucketMs),
        Number.MAX_SAFE_INTEGER,
        currentTimestamp,
        eventTimestamp,
      );
    }

    if (event.state === "moving" && currentState !== "moving") {
      addMovementCount(
        bucketMap,
        bucketMs,
        floorBucketStart(getMotionEventTimelineTimestamp(events[0]!), bucketMs),
        Number.MAX_SAFE_INTEGER,
        eventTimestamp,
      );
    }

    currentState = event.state;
    currentTimestamp = eventTimestamp;
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
  if (!(await hasMotionRollupTables(client))) {
    throw new Error("Motion rollup tables are not available in the target database.");
  }

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
     order by device_id asc, received_at asc, id asc`,
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
  if (!(await hasMotionRollupTables())) {
    return [];
  }

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
