import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  getDeviceSyncState,
  getFirmwareHistorySyncState,
  recordBackfillBatch,
} from "./backfill";
import { listDeviceMotionEventsByReceivedAt } from "./motion-events";
import { recordMotionEvent } from "./motion-events";
import { listMotionRollupBuckets, rebuildMotionRollups } from "./rollups";
import { closeDatabase, hasDatabaseTestEnv, resetDatabaseSchema } from "../test-helpers";
import { getDb } from "../db";

const describeDb = hasDatabaseTestEnv() ? describe : describe.skip;

async function rewriteBackfillReceivedAt(deviceId: string, receivedAtBySequence: Record<number, string>) {
  const client = await getDb().connect();

  try {
    const whenClauses = Object.entries(receivedAtBySequence)
      .map(([sequence, iso]) => `when ${sequence} then '${iso}'::timestamptz`)
      .join("\n");
    const sequences = Object.keys(receivedAtBySequence).map(Number);

    await client.query(
      `update motion_events
       set received_at = case sequence
         ${whenClauses}
       end
       where device_id = $1
         and sequence = any($2::bigint[])`,
      [deviceId, sequences],
    );
    await client.query("delete from motion_rollups_hourly where device_id = $1", [deviceId]);
    await client.query("delete from motion_rollups_daily where device_id = $1", [deviceId]);
    await rebuildMotionRollups(client, deviceId);
  } finally {
    client.release();
  }
}

describeDb("backfill repository", () => {
  beforeEach(async () => {
    await resetDatabaseSchema();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("records motion and log backfill while advancing sync state", async () => {
    const result = await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 2,
      records: [
        {
          kind: "motion",
          sequence: 1,
          state: "moving",
          delta: 5,
          timestamp: 100,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "node-log",
          sequence: 2,
          level: "info",
          code: "node.connected",
          message: "Gateway connected.",
          timestamp: 101,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
          metadata: {
            source: "test",
          },
        },
      ],
    });

    const syncState = await getDeviceSyncState("stack-001");

    expect(result.insertedEvents).toHaveLength(1);
    expect(result.insertedLogs).toHaveLength(1);
    expect(result.syncState).toMatchObject({
      deviceId: "stack-001",
      lastAckedSequence: 2,
      lastAckedBootId: "boot-1",
    });
    expect(syncState).toMatchObject({
      deviceId: "stack-001",
      lastAckedSequence: 2,
      lastAckedBootId: "boot-1",
    });
  });

  it("recomputes affected rollups when backfill lands between existing events", async () => {
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100_000,
      delta: 5,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 300_000,
      delta: 0,
      sequence: 3,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    await rewriteBackfillReceivedAt("stack-001", {
      1: "2026-03-18T00:01:40.000Z",
      3: "2026-03-18T00:05:00.000Z",
    });

    expect(
      await listMotionRollupBuckets({
        deviceId: "stack-001",
        window: "24h",
        startBucket: Date.parse("2026-03-18T00:00:00.000Z"),
        endBucketExclusive: Date.parse("2026-03-18T01:00:00.000Z"),
      }),
    ).toEqual([
      expect.objectContaining({
        bucketStart: Date.parse("2026-03-18T00:00:00.000Z"),
        movementCount: 1,
        movingSeconds: 200,
      }),
    ]);

    await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 12,
      records: [
        {
          kind: "motion",
          sequence: 2,
          state: "still",
          delta: 0,
          timestamp: 200_000,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
      ],
    });

    await rewriteBackfillReceivedAt("stack-001", {
      1: "2026-03-18T00:01:40.000Z",
      2: "2026-03-18T00:03:20.000Z",
      3: "2026-03-18T00:05:00.000Z",
    });

    expect(
      await listMotionRollupBuckets({
        deviceId: "stack-001",
        window: "24h",
        startBucket: Date.parse("2026-03-18T00:00:00.000Z"),
        endBucketExclusive: Date.parse("2026-03-18T01:00:00.000Z"),
      }),
    ).toEqual([
      expect.objectContaining({
        bucketStart: Date.parse("2026-03-18T00:00:00.000Z"),
        movementCount: 1,
        movingSeconds: 100,
      }),
    ]);
  });

  it("tracks sync state independently for each boot", async () => {
    await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 1,
      records: [
        {
          kind: "motion",
          sequence: 1,
          state: "moving",
          delta: 5,
          timestamp: 100,
          bootId: "boot-1",
        },
      ],
    });
    await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-2",
      ackSequence: 1,
      records: [
        {
          kind: "motion",
          sequence: 1,
          state: "still",
          delta: 0,
          timestamp: 200,
          bootId: "boot-2",
        },
      ],
    });

    const bootOneState = await getDeviceSyncState("stack-001", "boot-1");
    const bootTwoState = await getDeviceSyncState("stack-001", "boot-2");

    expect(bootOneState).toMatchObject({
      deviceId: "stack-001",
      lastAckedSequence: 1,
      lastAckedBootId: "boot-1",
    });
    expect(bootTwoState).toMatchObject({
      deviceId: "stack-001",
      lastAckedSequence: 1,
      lastAckedBootId: "boot-2",
    });
  });

  it("advances the global firmware history cursor across mixed-boot pages", async () => {
    const result = await recordBackfillBatch({
      deviceId: "stack-001",
      ackSequence: 767,
      records: [
        {
          kind: "node-log",
          sequence: 765,
          level: "info",
          code: "device.boot",
          message: "BLE node booted.",
          timestamp: 1,
          bootId: "boot-a",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "motion",
          sequence: 766,
          state: "still",
          delta: 0,
          timestamp: 2,
          bootId: "boot-a",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "node-log",
          sequence: 767,
          level: "info",
          code: "runtime.app_session.online",
          message: "Windows app session lease is active.",
          timestamp: 3,
          bootId: "boot-b",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
      ],
    });

    expect(result.historySyncState).toMatchObject({
      deviceId: "stack-001",
      lastAckedHistorySequence: 767,
    });
    expect(await getFirmwareHistorySyncState("stack-001")).toMatchObject({
      deviceId: "stack-001",
      lastAckedHistorySequence: 767,
    });
  });

  it("clamps an existing boot cursor at the first missing sequence in the batch", async () => {
    await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 2,
      records: [
        {
          kind: "motion",
          sequence: 1,
          state: "moving",
          delta: 5,
          timestamp: 1,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "node-log",
          sequence: 2,
          level: "info",
          code: "node.connected",
          message: "Gateway connected.",
          timestamp: 2,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
      ],
    });

    const result = await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 5,
      records: [
        {
          kind: "motion",
          sequence: 3,
          state: "moving",
          delta: 5,
          timestamp: 3,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "node-log",
          sequence: 5,
          level: "info",
          code: "node.connected",
          message: "Gateway connected.",
          timestamp: 5,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
      ],
    });

    expect(result.syncState.lastAckedSequence).toBe(3);
    expect(await getDeviceSyncState("stack-001", "boot-1")).toMatchObject({
      lastAckedSequence: 3,
    });
  });

  it("counts pre-existing duplicates toward contiguous durable coverage", async () => {
    await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 5,
      records: [
        {
          kind: "motion",
          sequence: 1,
          state: "moving",
          delta: 5,
          timestamp: 1,
          bootId: "boot-1",
        },
        {
          kind: "motion",
          sequence: 2,
          state: "still",
          delta: 0,
          timestamp: 2,
          bootId: "boot-1",
        },
        {
          kind: "motion",
          sequence: 3,
          state: "moving",
          delta: 4,
          timestamp: 3,
          bootId: "boot-1",
        },
        {
          kind: "motion",
          sequence: 4,
          state: "still",
          delta: 0,
          timestamp: 4,
          bootId: "boot-1",
        },
        {
          kind: "motion",
          sequence: 5,
          state: "moving",
          delta: 6,
          timestamp: 5,
          bootId: "boot-1",
        },
      ],
    });

    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 6,
      delta: 0,
      sequence: 6,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const result = await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 8,
      records: [
        {
          kind: "motion",
          sequence: 6,
          state: "still",
          delta: 0,
          timestamp: 6,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "node-log",
          sequence: 7,
          level: "info",
          code: "node.connected",
          message: "Gateway connected.",
          timestamp: 7,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "motion",
          sequence: 8,
          state: "moving",
          delta: 3,
          timestamp: 8,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
      ],
    });

    expect(result.syncState.lastAckedSequence).toBe(8);
    expect(await getDeviceSyncState("stack-001", "boot-1")).toMatchObject({
      lastAckedSequence: 8,
    });
  });

  it("derives backfill received_at from the latest live contact instead of import time", async () => {
    const liveWrite = await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 300_000,
      delta: 0,
      sequence: 3,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const result = await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 2,
      records: [
        {
          kind: "motion",
          sequence: 1,
          state: "moving",
          delta: 5,
          timestamp: 100_000,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "motion",
          sequence: 2,
          state: "still",
          delta: 0,
          timestamp: 200_000,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
      ],
    });

    expect(result.insertedEvents).toHaveLength(2);
    expect(Date.parse(result.insertedEvents[1]!.receivedAt)).toBeLessThan(
      Date.parse(liveWrite.event!.receivedAt),
    );
    expect(Date.parse(result.insertedEvents[1]!.receivedAt)).toBe(
      Date.parse(liveWrite.event!.receivedAt) - 100_000,
    );
    expect(Date.parse(result.insertedEvents[0]!.receivedAt)).toBe(
      Date.parse(liveWrite.event!.receivedAt) - 200_000,
    );

    const events = await listDeviceMotionEventsByReceivedAt({
      deviceId: "stack-001",
      startReceivedAt: new Date(Date.parse(result.insertedEvents[0]!.receivedAt) - 1).toISOString(),
      endReceivedAt: new Date(Date.parse(liveWrite.event!.receivedAt) + 1).toISOString(),
    });

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
