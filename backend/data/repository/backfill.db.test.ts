import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDeviceSyncState, recordBackfillBatch } from "./backfill";
import { listDeviceMotionEventsByReceivedAt } from "./motion-events";
import { recordMotionEvent } from "./motion-events";
import { listMotionRollupBuckets } from "./rollups";
import { closeDatabase, hasDatabaseTestEnv, resetDatabaseSchema } from "../test-helpers";

const describeDb = hasDatabaseTestEnv() ? describe : describe.skip;

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
      ackSequence: 12,
      records: [
        {
          kind: "motion",
          sequence: 10,
          state: "moving",
          delta: 5,
          timestamp: 100,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
        {
          kind: "node-log",
          sequence: 11,
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
      lastAckedSequence: 12,
      lastAckedBootId: "boot-1",
    });
    expect(syncState).toMatchObject({
      deviceId: "stack-001",
      lastAckedSequence: 12,
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

    expect(
      await listMotionRollupBuckets({
        deviceId: "stack-001",
        window: "24h",
        startBucket: 0,
        endBucketExclusive: 60 * 60 * 1000,
      }),
    ).toEqual([
      expect.objectContaining({
        bucketStart: 0,
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

    expect(
      await listMotionRollupBuckets({
        deviceId: "stack-001",
        window: "24h",
        startBucket: 0,
        endBucketExclusive: 60 * 60 * 1000,
      }),
    ).toEqual([
      expect.objectContaining({
        bucketStart: 0,
        movementCount: 1,
        movingSeconds: 100,
      }),
    ]);
  });

  it("tracks sync state independently for each boot", async () => {
    await recordBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-1",
      ackSequence: 12,
      records: [
        {
          kind: "motion",
          sequence: 10,
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
      ackSequence: 4,
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
      lastAckedSequence: 12,
      lastAckedBootId: "boot-1",
    });
    expect(bootTwoState).toMatchObject({
      deviceId: "stack-001",
      lastAckedSequence: 4,
      lastAckedBootId: "boot-2",
    });
  });

  it("fails noisy when a new sync cursor would advance without inserting any records", async () => {
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 5,
      sequence: 10,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    await expect(
      recordBackfillBatch({
        deviceId: "stack-001",
        bootId: "boot-1",
        ackSequence: 12,
        records: [
          {
            kind: "motion",
            sequence: 10,
            state: "moving",
            delta: 5,
            timestamp: 100,
            bootId: "boot-1",
            firmwareVersion: "0.5.3",
            hardwareId: "hw-1",
          },
        ],
      }),
    ).rejects.toThrow("Backfill mismatch");
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
      startTimestamp: Date.parse(result.insertedEvents[0]!.receivedAt) - 1,
      endTimestamp: Date.parse(liveWrite.event!.receivedAt) + 1,
    });

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
