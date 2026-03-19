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

export type ValidatedGatewayChildPersistMessage =
  | {
      type: "persist-motion";
      deviceId: string;
      payload: IngestPayload;
    }
  | {
      type: "persist-heartbeat";
      deviceId: string;
      payload: HeartbeatPayload;
    }
  | {
      type: "persist-device-log";
      deviceId: string;
      payload: DeviceLogInput;
    }
  | {
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

  function enqueue(deviceId: string, work: () => Promise<void>) {
    const current = chains.get(deviceId) ?? Promise.resolve();
    const next = current.then(work, work);
    const tracked = next.catch(() => {});
    chains.set(deviceId, tracked);
    return next.finally(() => {
      if (chains.get(deviceId) === tracked) {
        chains.delete(deviceId);
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
        const payload = await persistBackfill(message.payload);
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
      return enqueue(validated.deviceId, () => persistValidatedMessage(validated));
    },
    persistValidatedMessage(message: ValidatedGatewayChildPersistMessage) {
      return enqueue(message.deviceId, () => persistValidatedMessage(message));
    },
  };
}
