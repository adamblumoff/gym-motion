import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDataIngestSpool } from "./data-ingest-spool";

const tempDirs: string[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

describe("createDataIngestSpool", () => {
  it("replays pending rows after restart when a drain previously failed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-spool-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "ingest-spool.sqlite");
    const attemptedSequences: number[] = [];
    let shouldFail = true;

    const spool = createDataIngestSpool({
      dbPath,
      async persistValidatedMessage(message) {
        if (message.type !== "persist-motion") {
          throw new Error("Unexpected message type in test.");
        }

        attemptedSequences.push(message.payload.sequence ?? -1);

        if (shouldFail) {
          throw new Error("database offline");
        }
      },
    });

    await spool.start();
    await spool.enqueue({
      type: "persist-motion",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "moving",
        timestamp: 1,
        sequence: 7,
      },
    });

    await waitFor(() => attemptedSequences.length === 1);
    await spool.stop();

    const database = new DatabaseSync(dbPath);
    const pendingBeforeRestart = database.prepare(`
      select attempt_count
      from ingest_spool
      limit 1
    `).get() as { attempt_count?: number } | undefined;

    expect(pendingBeforeRestart?.attempt_count).toBe(1);

    database.prepare(`
      update ingest_spool
      set available_at = ?
    `).run(new Date().toISOString());
    database.close();

    shouldFail = false;
    const replaySpool = createDataIngestSpool({
      dbPath,
      async persistValidatedMessage(message) {
        if (message.type === "persist-motion") {
          attemptedSequences.push(message.payload.sequence ?? -1);
        }
      },
    });

    await replaySpool.start();
    await waitFor(() => attemptedSequences.length === 2);

    const verifyDatabase = new DatabaseSync(dbPath);
    const remainingRows = verifyDatabase.prepare(`
      select count(*) as row_count
      from ingest_spool
    `).get() as { row_count?: number } | undefined;
    verifyDatabase.close();

    expect(attemptedSequences).toEqual([7, 7]);
    expect(remainingRows?.row_count).toBe(0);

    await replaySpool.stop();
  });
});
