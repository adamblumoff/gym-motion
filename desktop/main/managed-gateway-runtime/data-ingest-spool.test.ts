import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

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
    const firstEnqueue = spool.enqueue({
      messageId: "msg-1",
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
    firstEnqueue.catch(() => {});
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
    const replayEnqueue = replaySpool.enqueue({
      messageId: "msg-1",
      type: "persist-motion",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "moving",
        timestamp: 1,
        sequence: 7,
      },
    });
    await waitFor(() => attemptedSequences.length === 2);
    await replayEnqueue;

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

  it("waits for in-flight drains to finish before closing and allows repeated stop calls", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-spool-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "ingest-spool.sqlite");
    let resolvePersist: (() => void) | null = null;
    let persistStarted = false;

    const spool = createDataIngestSpool({
      dbPath,
      persistValidatedMessage() {
        persistStarted = true;
        return new Promise<void>((resolve) => {
          resolvePersist = resolve;
        });
      },
    });

    await spool.start();
    const enqueuePromise = spool.enqueue({
      messageId: "msg-2",
      type: "persist-motion",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "moving",
        timestamp: 1,
        sequence: 7,
      },
    });

    await waitFor(() => persistStarted);

    let stopSettled = false;
    const stopPromise = spool.stop().then(() => {
      stopSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopSettled).toBe(false);

    resolvePersist?.();
    await stopPromise;
    await enqueuePromise;
    await spool.stop();

    const database = new DatabaseSync(dbPath);
    const remainingRows = database.prepare(`
      select count(*) as row_count
      from ingest_spool
    `).get() as { row_count?: number } | undefined;
    database.close();

    expect(remainingRows?.row_count).toBe(0);
  });

  it("records retry metadata before shutdown finishes when a drain fails in flight", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-spool-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "ingest-spool.sqlite");
    let rejectPersist: ((error: Error) => void) | null = null;
    let persistStarted = false;

    const spool = createDataIngestSpool({
      dbPath,
      persistValidatedMessage() {
        persistStarted = true;
        return new Promise<void>((_resolve, reject) => {
          rejectPersist = reject;
        });
      },
    });

    await spool.start();
    const enqueuePromise = spool.enqueue({
      messageId: "msg-3",
      type: "persist-motion",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "moving",
        timestamp: 1,
        sequence: 7,
      },
    });

    await waitFor(() => persistStarted);

    const stopPromise = spool.stop();
    rejectPersist?.(new Error("database offline"));
    await stopPromise;
    await expect(enqueuePromise).rejects.toThrow("Gateway ingest spool is stopping.");

    const database = new DatabaseSync(dbPath);
    const failedRow = database.prepare(`
      select attempt_count, last_error
      from ingest_spool
      limit 1
    `).get() as { attempt_count?: number; last_error?: string } | undefined;
    database.close();

    expect(failedRow?.attempt_count).toBe(1);
    expect(failedRow?.last_error).toContain("database offline");
  });

  it("rejects late enqueue attempts after shutdown without crashing and only warns once", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-spool-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "ingest-spool.sqlite");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const spool = createDataIngestSpool({
      dbPath,
      async persistValidatedMessage() {},
    });

    await spool.start();
    await spool.stop();

    const message = {
      messageId: "msg-4",
      type: "persist-motion" as const,
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "moving" as const,
        timestamp: 1,
        sequence: 7,
      },
    };

    await expect(spool.enqueue(message)).rejects.toThrow("Gateway ingest spool is stopping.");
    await expect(spool.enqueue(message)).rejects.toThrow("Gateway ingest spool is stopping.");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
