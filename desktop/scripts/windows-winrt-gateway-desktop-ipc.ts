// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PERSIST_MESSAGE_TYPES = new Set([
  "persist-motion",
  "persist-heartbeat",
  "persist-device-log",
]);
const ACK_TIMEOUT_MS = 4_000;
const MAX_BACKOFF_MS = 30_000;

let database = null;
let insertRow = null;
let selectReadyRows = null;
let deleteRow = null;
let markFailed = null;
let inflight = new Map();
let drainTimer = null;

function nextDelayMs(attemptCount) {
  return Math.min(500 * 2 ** Math.min(attemptCount, 6), MAX_BACKOFF_MS);
}

function outboxPath() {
  return (
    process.env.GATEWAY_CHILD_OUTBOX_PATH ??
    path.join(os.tmpdir(), "gym-motion-gateway-child-outbox.sqlite")
  );
}

function hasColumn(tableName, columnName) {
  const rows = database.prepare(`pragma table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureDatabase() {
  if (database) {
    return;
  }

  const dbPath = outboxPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  database = new DatabaseSync(dbPath);
  database.exec(`
    pragma journal_mode = wal;
    pragma synchronous = normal;
    create table if not exists outbox (
      id integer primary key autoincrement,
      message_id text not null unique,
      message_json text not null,
      created_at text not null,
      available_at text not null,
      attempt_count integer not null default 0,
      last_error text
    );
    create index if not exists outbox_available_idx
      on outbox (available_at, id);
  `);
  if (!hasColumn("outbox", "message_id")) {
    database.exec(`
      alter table outbox add column message_id text;
      update outbox
      set message_id = 'legacy-outbox-' || id
      where message_id is null or length(message_id) = 0;
      create unique index if not exists outbox_message_id_idx
        on outbox (message_id);
    `);
  } else {
    database.exec(`
      update outbox
      set message_id = 'legacy-outbox-' || id
      where message_id is null or length(message_id) = 0;
      create unique index if not exists outbox_message_id_idx
        on outbox (message_id);
    `);
  }
  insertRow = database.prepare(`
    insert into outbox (
      message_id,
      message_json,
      created_at,
      available_at,
      attempt_count,
      last_error
    )
    values (?, ?, ?, ?, 0, null)
    on conflict(message_id) do nothing
  `);
  selectReadyRows = database.prepare(`
    select id, message_id, message_json, attempt_count
    from outbox
    where available_at <= ?
    order by id asc
  `);
  deleteRow = database.prepare(`delete from outbox where message_id = ?`);
  markFailed = database.prepare(`
    update outbox
    set attempt_count = attempt_count + 1,
        available_at = ?,
        last_error = ?
    where message_id = ?
  `);
}

function clearDrainTimer() {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
}

function scheduleDrain(delayMs = 0) {
  clearDrainTimer();

  if (delayMs <= 0) {
    queueMicrotask(() => {
      void drainPersistOutbox();
    });
    return;
  }

  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainPersistOutbox();
  }, delayMs);
  drainTimer.unref?.();
}

function failMessage(messageId, attemptCount, detail, debug = () => {}) {
  ensureDatabase();
  const availableAt = new Date(Date.now() + nextDelayMs(attemptCount + 1)).toISOString();
  markFailed.run(availableAt, detail, messageId);
  debug("scheduled desktop persist retry", { messageId, detail, availableAt });
  scheduleDrain(nextDelayMs(attemptCount + 1));
}

function startAckTimer(messageId, attemptCount, debug = () => {}) {
  const existing = inflight.get(messageId);

  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    inflight.delete(messageId);
    failMessage(messageId, attemptCount, "desktop persist ack timed out", debug);
  }, ACK_TIMEOUT_MS);
  timer.unref?.();
  inflight.set(messageId, timer);
}

async function drainPersistOutbox(debug = () => {}) {
  ensureDatabase();

  if (typeof process.send !== "function") {
    debug("desktop IPC channel unavailable");
    return;
  }

  const rows = selectReadyRows.all(new Date().toISOString()) ?? [];

  for (const row of rows) {
    if (inflight.has(row.message_id)) {
      continue;
    }

    try {
      process.send(JSON.parse(row.message_json));
      startAckTimer(row.message_id, row.attempt_count, debug);
    } catch (error) {
      failMessage(
        row.message_id,
        row.attempt_count,
        error instanceof Error ? error.message : String(error),
        debug,
      );
    }
  }
}

function isPersistMessage(message) {
  return !!message && PERSIST_MESSAGE_TYPES.has(message.type);
}

export function handlePersistAck(message, debug = () => {}) {
  if (!message || message.type !== "persist-ack" || typeof message.messageId !== "string") {
    return false;
  }

  const timer = inflight.get(message.messageId);

  if (timer) {
    clearTimeout(timer);
    inflight.delete(message.messageId);
  }

  ensureDatabase();

  if (message.ok) {
    deleteRow.run(message.messageId);
    return true;
  }

  const existing = database
    .prepare(`select attempt_count from outbox where message_id = ? limit 1`)
    .get(message.messageId);

  if (existing) {
    failMessage(
      message.messageId,
      existing.attempt_count ?? 0,
      message.error ?? "desktop persist rejected",
      debug,
    );
  }

  return true;
}

export function sendToDesktop(message, debug = () => {}) {
  if (!isPersistMessage(message)) {
    if (typeof process.send !== "function") {
      debug("desktop IPC channel unavailable");
      return false;
    }

    try {
      process.send(message);
      return true;
    } catch (error) {
      debug(
        "failed to send desktop IPC message",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  ensureDatabase();
  const persistedMessage = {
    ...message,
    messageId:
      typeof message.messageId === "string" && message.messageId.length > 0
        ? message.messageId
        : randomUUID(),
  };
  const timestamp = new Date().toISOString();

  insertRow.run(
    persistedMessage.messageId,
    JSON.stringify(persistedMessage),
    timestamp,
    timestamp,
  );
  scheduleDrain();
  return true;
}

export function closeDesktopIpcForTests() {
  clearDrainTimer();

  for (const timer of inflight.values()) {
    clearTimeout(timer);
  }

  inflight.clear();

  if (database) {
    database.close();
  }

  database = null;
  insertRow = null;
  selectReadyRows = null;
  deleteRow = null;
  markFailed = null;
}

ensureDatabase();
scheduleDrain();
