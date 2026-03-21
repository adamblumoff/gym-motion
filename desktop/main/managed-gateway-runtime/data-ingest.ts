import {
  type BackfillBatchInput,
  type DeviceLogInput,
  formatZodError,
  type HeartbeatPayload,
  type IngestPayload,
  parseBackfillBatch,
  parseDeviceLog,
  parseHeartbeatPayload,
  parseIngestPayload,
} from "@core/contracts";

import {
  recordBackfillBatch,
  recordDeviceLog,
  recordHeartbeat,
  recordMotionEvent,
} from "../../../backend/data";
import type { DesktopDataEvent } from "../desktop-api-server";
import type { GatewayChildPersistMessage } from "./gateway-child-ipc";

type DataIngestDeps = {
  applyDataEvent: (event: DesktopDataEvent) => void;
  recordMotion?: typeof recordMotionEvent;
  recordHeartbeat?: typeof recordHeartbeat;
  recordLog?: typeof recordDeviceLog;
  recordBackfill?: typeof recordBackfillBatch;
};

type QueueKey = string;

function queueKeyForMessage(message: { deviceId: string }) {
  return message.deviceId;
}

function logIngest(message: string, details: Record<string, unknown>) {
  console.info(`[runtime] ${message}`, details);
}

export type ValidatedGatewayChildPersistMessage =
  | {
      messageId: string;
      type: "persist-motion";
      deviceId: string;
      payload: IngestPayload;
    }
  | {
      messageId: string;
      type: "persist-heartbeat";
      deviceId: string;
      payload: HeartbeatPayload;
    }
  | {
      messageId: string;
      type: "persist-device-log";
      deviceId: string;
      payload: DeviceLogInput;
    }
  | {
      messageId: string;
      type: "persist-device-backfill";
      deviceId: string;
      payload: BackfillBatchInput;
    };

export function validateGatewayChildPersistMessage(
  message: GatewayChildPersistMessage,
): ValidatedGatewayChildPersistMessage {
  switch (message.type) {
    case "persist-motion": {
      const parsed = parseIngestPayload(message.payload);

      if (!parsed.success) {
        throw new Error(`persist-motion: ${formatZodError(parsed.error)}`);
      }

      if (parsed.data.deviceId !== message.deviceId) {
        throw new Error("persist-motion: message deviceId did not match payload deviceId.");
      }

      return {
        messageId: message.messageId,
        type: message.type,
        deviceId: message.deviceId,
        payload: parsed.data,
      };
    }
    case "persist-heartbeat": {
      const parsed = parseHeartbeatPayload(message.payload);

      if (!parsed.success) {
        throw new Error(`persist-heartbeat: ${formatZodError(parsed.error)}`);
      }

      if (parsed.data.deviceId !== message.deviceId) {
        throw new Error("persist-heartbeat: message deviceId did not match payload deviceId.");
      }

      return {
        messageId: message.messageId,
        type: message.type,
        deviceId: message.deviceId,
        payload: parsed.data,
      };
    }
    case "persist-device-log": {
      const parsed = parseDeviceLog(message.payload);

      if (!parsed.success) {
        throw new Error(`persist-device-log: ${formatZodError(parsed.error)}`);
      }

      if (parsed.data.deviceId !== message.deviceId) {
        throw new Error("persist-device-log: message deviceId did not match payload deviceId.");
      }

      return {
        messageId: message.messageId,
        type: message.type,
        deviceId: message.deviceId,
        payload: parsed.data,
      };
    }
    case "persist-device-backfill": {
      const parsed = parseBackfillBatch(message.payload);

      if (!parsed.success) {
        throw new Error(`persist-device-backfill: ${formatZodError(parsed.error)}`);
      }

      if (parsed.data.deviceId !== message.deviceId) {
        throw new Error(
          "persist-device-backfill: message deviceId did not match payload deviceId.",
        );
      }

      return {
        messageId: message.messageId,
        type: message.type,
        deviceId: message.deviceId,
        payload: parsed.data,
      };
    }
  }
}

export function createDataIngestController(deps: DataIngestDeps) {
  const chains = new Map<QueueKey, Promise<void>>();
  const persistMotion = deps.recordMotion ?? recordMotionEvent;
  const persistHeartbeat = deps.recordHeartbeat ?? recordHeartbeat;
  const persistLog = deps.recordLog ?? recordDeviceLog;
  const persistBackfill = deps.recordBackfill ?? recordBackfillBatch;

  function enqueue(queueKey: QueueKey, work: () => Promise<void>) {
    const current = chains.get(queueKey) ?? Promise.resolve();
    const next = current.then(work, work);
    const tracked = next.catch(() => {});
    chains.set(queueKey, tracked);
    return next.finally(() => {
      if (chains.get(queueKey) === tracked) {
        chains.delete(queueKey);
      }
    });
  }

  async function persistValidatedMessage(message: ValidatedGatewayChildPersistMessage) {
    switch (message.type) {
      case "persist-motion": {
        const payload = await persistMotion(message.payload);
        deps.applyDataEvent({
          type: "motion-update",
          payload,
        });
        return;
      }
      case "persist-heartbeat": {
        const payload = await persistHeartbeat(message.payload);
        deps.applyDataEvent({
          type: "device-updated",
          payload: payload.device,
        });
        return;
      }
      case "persist-device-log": {
        const payload = await persistLog(message.payload);
        deps.applyDataEvent({
          type: "device-log",
          payload,
        });
        return;
      }
      case "persist-device-backfill": {
        logIngest("persisting backfill batch", {
          messageId: message.messageId,
          deviceId: message.deviceId,
          ackSequence: message.payload.ackSequence,
          recordCount: message.payload.records.length,
        });
        const payload = await persistBackfill(message.payload);
        logIngest("persisted backfill batch", {
          messageId: message.messageId,
          deviceId: message.deviceId,
          ackSequence: message.payload.ackSequence,
          insertedEventCount: payload.insertedEvents.length,
          insertedLogCount: payload.insertedLogs.length,
          provenAckSequence:
            payload.historySyncState?.lastAckedHistorySequence ?? payload.syncState.lastAckedSequence,
        });
        deps.applyDataEvent({
          type: "backfill-recorded",
          payload,
          deviceId: message.payload.deviceId,
        });
      }
    }
  }

  return {
    handleMessage(message: GatewayChildPersistMessage) {
      const validated = validateGatewayChildPersistMessage(message);
      const queueKey = queueKeyForMessage(validated);
      const queueBusy = chains.has(queueKey);

      if (validated.type === "persist-device-backfill" || queueBusy) {
        logIngest("queued ingest message", {
          messageId: validated.messageId,
          type: validated.type,
          deviceId: validated.deviceId,
          queueBusy,
          ackSequence:
            validated.type === "persist-device-backfill"
              ? validated.payload.ackSequence
              : undefined,
        });
      }

      return enqueue(queueKey, () => persistValidatedMessage(validated));
    },
    persistValidatedMessage(message: ValidatedGatewayChildPersistMessage) {
      const queueKey = queueKeyForMessage(message);
      return enqueue(queueKey, () => persistValidatedMessage(message));
    },
  };
}
