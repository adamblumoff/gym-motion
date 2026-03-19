import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalProcessSend = process.send;

async function loadHelper() {
  vi.resetModules();
  return await import("./windows-winrt-gateway-desktop-ipc");
}

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
  process.send = originalProcessSend;
  delete process.env.GATEWAY_CHILD_OUTBOX_PATH;
  vi.useRealTimers();

  try {
    const helper = await loadHelper();
    helper.closeDesktopIpcForTests?.();
  } catch {}

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

describe("windows winrt gateway desktop IPC", () => {
  it("retries persist messages when the desktop ack never arrives", async () => {
    vi.useFakeTimers();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-child-outbox-"));
    tempDirs.push(tempDir);
    process.env.GATEWAY_CHILD_OUTBOX_PATH = path.join(tempDir, "outbox.sqlite");
    const sentMessages: Array<Record<string, unknown>> = [];
    process.send = ((message: unknown) => {
      sentMessages.push(message as Record<string, unknown>);
      return true;
    }) as typeof process.send;

    const helper = await loadHelper();

    expect(
      helper.sendToDesktop({
        type: "persist-motion",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          state: "moving",
          timestamp: 1,
          sequence: 7,
        },
      }),
    ).toBe(true);

    await vi.runAllTicks();
    expect(sentMessages).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]?.messageId).toBe(sentMessages[1]?.messageId);
    helper.closeDesktopIpcForTests();
  });

  it("replays unacked persist messages from disk on startup", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-child-outbox-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "outbox.sqlite");
    process.env.GATEWAY_CHILD_OUTBOX_PATH = dbPath;

    const database = new DatabaseSync(dbPath);
    database.exec(`
      pragma journal_mode = wal;
      create table if not exists outbox (
        id integer primary key autoincrement,
        message_id text not null unique,
        message_json text not null,
        created_at text not null,
        available_at text not null,
        attempt_count integer not null default 0,
        last_error text
      );
    `);
    database.prepare(`
      insert into outbox (message_id, message_json, created_at, available_at, attempt_count, last_error)
      values (?, ?, ?, ?, 0, null)
    `).run(
      "persist-1",
      JSON.stringify({
        messageId: "persist-1",
        type: "persist-motion",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          state: "moving",
          timestamp: 1,
          sequence: 7,
        },
      }),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    database.close();

    const sentMessages: Array<Record<string, unknown>> = [];
    process.send = ((message: unknown) => {
      sentMessages.push(message as Record<string, unknown>);
      return true;
    }) as typeof process.send;

    const helper = await loadHelper();
    await waitFor(() => sentMessages.length === 1);
    helper.closeDesktopIpcForTests();

    expect(sentMessages[0]).toMatchObject({
      messageId: "persist-1",
      type: "persist-motion",
      deviceId: "stack-001",
    });
  });
});
