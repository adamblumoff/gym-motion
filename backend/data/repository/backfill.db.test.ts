import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDeviceSyncState, recordBackfillBatch } from "./backfill";
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
      timestamp: 100,
      delta: 5,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 300,
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
          timestamp: 200,
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
});
