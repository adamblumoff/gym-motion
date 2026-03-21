import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  findLatestDeviceMotionEventBeforeReceivedAt,
  listDeviceMotionEventsByReceivedAt,
  recordHeartbeat,
  recordMotionEvent,
} from "./motion-events";
import { listMotionRollupBuckets, rebuildMotionRollups } from "./rollups";
import { closeDatabase, hasDatabaseTestEnv, resetDatabaseSchema } from "../test-helpers";
import { getDb } from "../db";

const describeDb = hasDatabaseTestEnv() ? describe : describe.skip;

describeDb("motion event repository", () => {
  beforeEach(async () => {
    await resetDatabaseSchema();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("deduplicates repeated motion sequences and returns the stored canonical event", async () => {
    const first = await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 9,
      sequence: 4,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    const second = await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 9,
      sequence: 4,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    expect(first.event).toMatchObject({
      sequence: 4,
      eventTimestamp: 100,
    });
    expect(second.event).toMatchObject({
      sequence: 4,
      eventTimestamp: 100,
    });
    expect(second.event?.id).toBe(first.event?.id);
  });

  it("allows the same device sequence to be recorded on a different boot", async () => {
    const first = await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 9,
      sequence: 4,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    const second = await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 200,
      delta: 0,
      sequence: 4,
      bootId: "boot-2",
      firmwareVersion: "0.5.4",
      hardwareId: "hw-1",
    });

    expect(first.event?.id).not.toBe(second.event?.id);
    expect(second.event).toMatchObject({
      sequence: 4,
      eventTimestamp: 200,
      bootId: "boot-2",
    });
  });

  it("records hourly rollups once per movement start and avoids double-counting duplicate sequences", async () => {
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100_000,
      delta: 9,
      sequence: 4,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 110_000,
      delta: 0,
      sequence: 5,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 110_000,
      delta: 0,
      sequence: 5,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const buckets = await listMotionRollupBuckets({
      deviceId: "stack-001",
      window: "24h",
      startBucket: 0,
      endBucketExclusive: 60 * 60 * 1000,
    });

    expect(buckets).toEqual([
      expect.objectContaining({
        bucketStart: 0,
        movementCount: 1,
        movingSeconds: 10,
      }),
    ]);
  });

  it("splits moving duration across hourly bucket boundaries", async () => {
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 55 * 60 * 1000,
      delta: 3,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 65 * 60 * 1000,
      delta: 0,
      sequence: 2,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const buckets = await listMotionRollupBuckets({
      deviceId: "stack-001",
      window: "24h",
      startBucket: 0,
      endBucketExclusive: 2 * 60 * 60 * 1000,
    });

    expect(buckets).toEqual([
      expect.objectContaining({
        bucketStart: 0,
        movementCount: 1,
        movingSeconds: 5 * 60,
      }),
      expect.objectContaining({
        bucketStart: 60 * 60 * 1000,
        movementCount: 0,
        movingSeconds: 5 * 60,
      }),
    ]);
  });

  it("orders received-at queries by receipt time and preserves heartbeat upserts", async () => {
    await recordHeartbeat({
      deviceId: "stack-001",
      timestamp: 50,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 3,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 110,
      delta: 0,
      sequence: 2,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const events = await listDeviceMotionEventsByReceivedAt({
      deviceId: "stack-001",
      startReceivedAt: "1970-01-01T00:00:00.000Z",
    });
    const latestBeforeSecond = await findLatestDeviceMotionEventBeforeReceivedAt({
      deviceId: "stack-001",
      beforeReceivedAt: events[1]!.receivedAt,
    });

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(latestBeforeSecond).toMatchObject({
      sequence: 1,
      eventTimestamp: 100,
    });
  });

  it("rebuilds rollups from raw motion history", async () => {
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100_000,
      delta: 1,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 130_000,
      delta: 0,
      sequence: 2,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const db = getDb();
    const client = await db.connect();

    try {
      await client.query("delete from motion_rollups_hourly where device_id = $1", ["stack-001"]);
      await client.query("delete from motion_rollups_daily where device_id = $1", ["stack-001"]);
      await rebuildMotionRollups(client, "stack-001");
    } finally {
      client.release();
    }

    const buckets = await listMotionRollupBuckets({
      deviceId: "stack-001",
      window: "24h",
      startBucket: 0,
      endBucketExclusive: 60 * 60 * 1000,
    });

    expect(buckets).toEqual([
      expect.objectContaining({
        bucketStart: 0,
        movementCount: 1,
        movingSeconds: 30,
      }),
    ]);
  });

  it("builds daily rollups from received-at time instead of device-relative timestamps", async () => {
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1_000,
      delta: 1,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 31_000,
      delta: 0,
      sequence: 2,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const db = getDb();
    const client = await db.connect();

    try {
      await client.query(
        `update motion_events
         set received_at = case sequence
           when 1 then '2026-03-18T23:59:50.000Z'::timestamptz
           when 2 then '2026-03-19T00:00:20.000Z'::timestamptz
         end
         where device_id = $1`,
        ["stack-001"],
      );
      await client.query("delete from motion_rollups_hourly where device_id = $1", ["stack-001"]);
      await client.query("delete from motion_rollups_daily where device_id = $1", ["stack-001"]);
      await rebuildMotionRollups(client, "stack-001");
    } finally {
      client.release();
    }

    const dayStart = Date.parse("2026-03-18T00:00:00.000Z");
    const buckets = await listMotionRollupBuckets({
      deviceId: "stack-001",
      window: "7d",
      startBucket: dayStart,
      endBucketExclusive: dayStart + 2 * 24 * 60 * 60 * 1000,
    });

    expect(buckets).toEqual([
      expect.objectContaining({
        bucketStart: Date.parse("2026-03-18T00:00:00.000Z"),
        movementCount: 1,
        movingSeconds: 10,
      }),
      expect.objectContaining({
        bucketStart: Date.parse("2026-03-19T00:00:00.000Z"),
        movementCount: 0,
        movingSeconds: 20,
      }),
    ]);
  });
});
