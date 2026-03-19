import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDeviceSyncState, recordBackfillBatch } from "./backfill";
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
});
