import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GatewayChildPersistMessage } from "./gateway-child-ipc";
import {
  validateGatewayChildPersistMessage,
  type ValidatedGatewayChildPersistMessage,
} from "./data-ingest";

type PersistMessageType = GatewayChildPersistMessage["type"];

type IngestSpoolRow = {
  id: number;
  message_id: string;
  device_id: string;
  message_type: PersistMessageType;
  payload_json: string;
  attempt_count: number;
};

type DataIngestSpoolDeps = {
  dbPath: string;
  persistValidatedMessage: (message: ValidatedGatewayChildPersistMessage) => Promise<void>;
  onDrainError?: (message: string, error: unknown) => void;
};

export type DataIngestSpool = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  enqueue: (message: GatewayChildPersistMessage) => Promise<void>;
  enqueueAndDrain: (message: GatewayChildPersistMessage) => Promise<void>;
};

const MAX_BACKOFF_MS = 30_000;
const STOPPING_ERROR_MESSAGE = "Gateway ingest spool is stopping.";

function logBackfillSpool(message: string, details: Record<string, unknown>) {
  console.info(`[runtime] ${message}`, details);
}

function nowIso() {
  return new Date().toISOString();
}

function nextDelayMs(attemptCount: number) {
  return Math.min(500 * 2 ** Math.min(attemptCount, 6), MAX_BACKOFF_MS);
}

function deserializeRow(row: IngestSpoolRow): ValidatedGatewayChildPersistMessage {
  return validateGatewayChildPersistMessage({
    messageId: row.message_id,
    type: row.message_type,
    deviceId: row.device_id,
    payload: JSON.parse(row.payload_json),
  });
}

function hasColumn(database: DatabaseSync, tableName: string, columnName: string) {
  const rows = database
    .prepare(`pragma table_info(${tableName})`)
    .all() as Array<{ name?: string }>;

  return rows.some((row) => row.name === columnName);
}

export function createDataIngestSpool(deps: DataIngestSpoolDeps): DataIngestSpool {
  const dbDirectory = path.dirname(deps.dbPath);
  fs.mkdirSync(dbDirectory, { recursive: true });

  const database = new DatabaseSync(deps.dbPath);
  database.exec(`
    pragma journal_mode = wal;
    pragma synchronous = normal;
    create table if not exists ingest_spool (
      id integer primary key autoincrement,
      message_id text not null unique,
      device_id text not null,
      message_type text not null,
      payload_json text not null,
      created_at text not null,
      available_at text not null,
      attempt_count integer not null default 0,
      last_error text
    );
    create index if not exists ingest_spool_available_idx
      on ingest_spool (available_at, id);
    create index if not exists ingest_spool_device_idx
      on ingest_spool (device_id, id);
  `);

  if (!hasColumn(database, "ingest_spool", "message_id")) {
    database.exec(`
      alter table ingest_spool add column message_id text;
      update ingest_spool
      set message_id = 'legacy-ingest-' || id
      where message_id is null or length(message_id) = 0;
      create unique index if not exists ingest_spool_message_id_idx
        on ingest_spool (message_id);
    `);
  } else {
    database.exec(`
      update ingest_spool
      set message_id = 'legacy-ingest-' || id
      where message_id is null or length(message_id) = 0;
      create unique index if not exists ingest_spool_message_id_idx
        on ingest_spool (message_id);
    `);
  }

  const insertRow = database.prepare(`
    insert into ingest_spool (
      message_id,
      device_id,
      message_type,
      payload_json,
      created_at,
      available_at,
      attempt_count,
      last_error
    )
    values (?, ?, ?, ?, ?, ?, 0, null)
    on conflict(message_id) do nothing
  `);
  const selectReadyRows = database.prepare(`
    select
      spool.id,
      spool.message_id,
      spool.device_id,
      spool.message_type,
      spool.payload_json,
      spool.attempt_count
    from ingest_spool spool
    where spool.available_at <= ?
      and spool.id = (
        select min(first_per_device.id)
        from ingest_spool first_per_device
        where first_per_device.device_id = spool.device_id
      )
    order by spool.id asc
  `);
  const deleteRow = database.prepare(`delete from ingest_spool where id = ?`);
  const markFailed = database.prepare(`
    update ingest_spool
    set attempt_count = attempt_count + 1,
        available_at = ?,
        last_error = ?
    where id = ?
  `);
  const nextAvailableAt = database.prepare(`
    select available_at
    from ingest_spool
    order by available_at asc, id asc
    limit 1
  `);
  const selectRowByMessageId = database.prepare(`
    select
      id,
      message_id,
      device_id,
      message_type,
      payload_json,
      attempt_count
    from ingest_spool
    where message_id = ?
    limit 1
  `);

  const drainingDevices = new Set<string>();
  const activeDrains = new Set<Promise<void>>();
  const pendingResolvers = new Map<
    string,
    Array<{ resolve: () => void; reject: (error: Error) => void }>
  >();
  let state: "running" | "stopping" | "stopped" = "running";
  let drainTimer: NodeJS.Timeout | null = null;
  let didWarnOnRejectedEnqueue = false;
  let stopPromise: Promise<void> | null = null;

  function rejectPendingResolvers(error: Error) {
    for (const waiters of pendingResolvers.values()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }

    pendingResolvers.clear();
  }

  function resolveMessage(messageId: string) {
    const waiters = pendingResolvers.get(messageId);

    if (!waiters) {
      return;
    }

    pendingResolvers.delete(messageId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  function awaitMessage(messageId: string) {
    return new Promise<void>((resolve, reject) => {
      const waiters = pendingResolvers.get(messageId) ?? [];
      waiters.push({ resolve, reject });
      pendingResolvers.set(messageId, waiters);
    });
  }

  function clearDrainTimer() {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
  }

  function scheduleDrain(delayMs = 0) {
    if (state !== "running") {
      return;
    }

    if (delayMs <= 0) {
      clearDrainTimer();
      queueMicrotask(() => {
        if (state === "running") {
          void drainAvailable();
        }
      });
      return;
    }

    if (drainTimer) {
      return;
    }

    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (state === "running") {
        void drainAvailable();
      }
    }, delayMs);
    drainTimer.unref?.();
  }

  function scheduleNextAvailableDrain() {
    if (state !== "running") {
      return;
    }

    const nextRow = nextAvailableAt.get() as { available_at?: string } | undefined;

    if (!nextRow?.available_at) {
      return;
    }

    const delayMs = Math.max(0, Date.parse(nextRow.available_at) - Date.now());
    scheduleDrain(delayMs);
  }

  async function processRow(row: IngestSpoolRow) {
    drainingDevices.add(row.device_id);

    try {
      if (row.message_type === "persist-device-backfill") {
        logBackfillSpool("draining backfill spool message", {
          messageId: row.message_id,
          deviceId: row.device_id,
          attemptCount: row.attempt_count,
        });
      }

      await deps.persistValidatedMessage(deserializeRow(row));
      deleteRow.run(row.id);
      resolveMessage(row.message_id);

      if (row.message_type === "persist-device-backfill") {
        logBackfillSpool("drained backfill spool message", {
          messageId: row.message_id,
          deviceId: row.device_id,
        });
      }
    } catch (error) {
      const attemptCount = row.attempt_count + 1;
      const detail = error instanceof Error ? error.message : String(error);
      const availableAt = new Date(Date.now() + nextDelayMs(attemptCount)).toISOString();
      markFailed.run(availableAt, detail, row.id);
      deps.onDrainError?.(
        `[runtime] failed to drain persisted gateway child message ${row.message_type} for ${row.device_id}`,
        error,
      );
    } finally {
      drainingDevices.delete(row.device_id);
      scheduleDrain();
      scheduleNextAvailableDrain();
    }
  }

  function trackDrainTask(task: Promise<void>) {
    activeDrains.add(task);
    task.finally(() => {
      activeDrains.delete(task);
    });
  }

  async function drainAvailable() {
    if (state !== "running") {
      return;
    }

    const rows = selectReadyRows.all(nowIso()) as IngestSpoolRow[];

    for (const row of rows) {
      if (drainingDevices.has(row.device_id)) {
        continue;
      }

      trackDrainTask(processRow(row));
    }

    if (rows.length === 0) {
      scheduleNextAvailableDrain();
    }
  }

  async function enqueueInternal(
    message: GatewayChildPersistMessage,
    options?: { waitForDrain?: boolean },
  ) {
    if (state !== "running") {
      if (!didWarnOnRejectedEnqueue) {
        didWarnOnRejectedEnqueue = true;
        console.warn("[runtime] rejected ingest spool enqueue because the runtime is stopping.");
      }

      throw new Error(STOPPING_ERROR_MESSAGE);
    }

    const validated = validateGatewayChildPersistMessage(message);
    const timestamp = nowIso();

    insertRow.run(
      validated.messageId,
      validated.deviceId,
      validated.type,
      JSON.stringify(validated.payload),
      timestamp,
      timestamp,
    );

    if (validated.type === "persist-device-backfill") {
      logBackfillSpool("queued backfill spool message", {
        messageId: validated.messageId,
        deviceId: validated.deviceId,
        ackSequence: validated.payload.ackSequence,
        recordCount: validated.payload.records.length,
      });
    }

    const existingRow = selectRowByMessageId.get(validated.messageId) as
      | IngestSpoolRow
      | undefined;

    if (!existingRow) {
      return;
    }

    const completion = options?.waitForDrain ? awaitMessage(validated.messageId) : null;
    scheduleDrain();
    if (completion) {
      return await completion;
    }
  }

  return {
    async start() {
      if (state === "stopped") {
        throw new Error("Gateway ingest spool has already been stopped.");
      }

      scheduleDrain();
    },
    async stop() {
      if (state === "stopped") {
        return;
      }

      if (stopPromise) {
        return stopPromise;
      }

      state = "stopping";
      clearDrainTimer();
      stopPromise = (async () => {
        await Promise.allSettled([...activeDrains]);
        rejectPendingResolvers(new Error(STOPPING_ERROR_MESSAGE));
        database.close();
        state = "stopped";
      })();
      await stopPromise;
    },
    async enqueue(message) {
      await enqueueInternal(message);
    },
    async enqueueAndDrain(message) {
      await enqueueInternal(message, { waitForDrain: true });
    },
  };
}
