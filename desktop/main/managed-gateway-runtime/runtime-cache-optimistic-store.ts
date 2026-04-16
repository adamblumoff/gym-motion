import type {
  DeviceActivitySummary,
  DeviceLogInput,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  IngestPayload,
  MotionEventSummary,
} from "@core/contracts";

import type { RuntimeBatchPatchState } from "./runtime-cache-types";

type OptimisticMotionRecord = {
  messageId: string;
  event: MotionEventSummary;
  activity: DeviceActivitySummary;
};

type OptimisticLogRecord = {
  messageId: string;
  log: DeviceLogSummary;
  activity: DeviceActivitySummary;
};

export function createRuntimeCacheOptimisticStore({
  getMutableSnapshot,
  getDevice,
  upsertDevice,
  pushEvent,
  pushLog,
  pushActivity,
  trimPerDeviceActivities,
}: {
  getMutableSnapshot: () => {
    events: MotionEventSummary[];
    logs: DeviceLogSummary[];
    activities: DeviceActivitySummary[];
  };
  getDevice: (deviceId: string) => GatewayRuntimeDeviceSummary | null;
  upsertDevice: (device: GatewayRuntimeDeviceSummary) => void;
  pushEvent: (event: MotionEventSummary) => void;
  pushLog: (log: DeviceLogSummary) => void;
  pushActivity: (activity: DeviceActivitySummary) => void;
  trimPerDeviceActivities: (deviceId: string) => void;
}) {
  let syntheticId = -1;
  const optimisticMotionByMessageId = new Map<string, OptimisticMotionRecord>();
  const optimisticLogByMessageId = new Map<string, OptimisticLogRecord>();

  function clearOptimisticMessage(messageId: string) {
    const snapshot = getMutableSnapshot();
    const removedEventIds: Array<number | string> = [];
    const removedLogIds: Array<number | string> = [];
    const removedActivityIds: Array<number | string> = [];
    const optimisticMotion = optimisticMotionByMessageId.get(messageId);
    if (optimisticMotion) {
      optimisticMotionByMessageId.delete(messageId);
      snapshot.events = snapshot.events.filter((event) => event.id !== optimisticMotion.event.id);
      snapshot.activities = snapshot.activities.filter(
        (activity) => activity.id !== optimisticMotion.activity.id,
      );
      removedEventIds.push(optimisticMotion.event.id);
      removedActivityIds.push(optimisticMotion.activity.id);
      trimPerDeviceActivities(optimisticMotion.activity.deviceId);
    }

    const optimisticLog = optimisticLogByMessageId.get(messageId);
    if (optimisticLog) {
      optimisticLogByMessageId.delete(messageId);
      snapshot.logs = snapshot.logs.filter((log) => log.id !== optimisticLog.log.id);
      snapshot.activities = snapshot.activities.filter(
        (activity) => activity.id !== optimisticLog.activity.id,
      );
      removedLogIds.push(optimisticLog.log.id);
      removedActivityIds.push(optimisticLog.activity.id);
      trimPerDeviceActivities(optimisticLog.activity.deviceId);
    }

    return {
      removedEventIds,
      removedLogIds,
      removedActivityIds,
    };
  }

  function recordOptimisticMotion(messageId: string, payload: IngestPayload): RuntimeBatchPatchState {
    clearOptimisticMessage(messageId);

    const existingDevice = getDevice(payload.deviceId);
    const batch: RuntimeBatchPatchState = {
      devices: [],
      events: [],
      logs: [],
      activities: [],
    };

    if (existingDevice) {
      const receivedAt = new Date().toISOString();
      const nextDevice: GatewayRuntimeDeviceSummary = {
        ...existingDevice,
        lastState: payload.state,
        lastSeenAt: payload.timestamp,
        lastDelta: payload.delta ?? null,
        updatedAt: receivedAt,
        bootId: payload.bootId ?? existingDevice.bootId,
        firmwareVersion: payload.firmwareVersion ?? existingDevice.firmwareVersion,
        hardwareId: payload.hardwareId ?? existingDevice.hardwareId,
        lastEventReceivedAt: receivedAt,
      };
      upsertDevice(nextDevice);
      batch.devices.push(nextDevice);
    }

    const event: MotionEventSummary = {
      id: syntheticId--,
      deviceId: payload.deviceId,
      sequence: payload.sequence ?? null,
      state: payload.state,
      delta: payload.delta ?? null,
      eventTimestamp: payload.timestamp,
      receivedAt: new Date().toISOString(),
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? null,
      hardwareId: payload.hardwareId ?? null,
    };
    const activity: DeviceActivitySummary = {
      id: `optimistic-motion:${messageId}`,
      deviceId: payload.deviceId,
      sequence: payload.sequence ?? null,
      kind: "motion",
      title: payload.state.toUpperCase(),
      message: `Gateway recorded ${payload.state} for ${payload.deviceId}.`,
      state: payload.state,
      level: null,
      code: "motion.state",
      delta: payload.delta ?? null,
      eventTimestamp: payload.timestamp,
      receivedAt: event.receivedAt,
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? null,
      hardwareId: payload.hardwareId ?? null,
      metadata:
        payload.delta === undefined || payload.delta === null ? null : { delta: payload.delta },
    };

    optimisticMotionByMessageId.set(messageId, { messageId, event, activity });
    pushEvent(event);
    pushActivity(activity);
    batch.events.push(event);
    batch.activities.push(activity);
    return batch;
  }

  function recordOptimisticLog(messageId: string, payload: DeviceLogInput): RuntimeBatchPatchState {
    clearOptimisticMessage(messageId);
    const receivedAt = new Date().toISOString();
    const log: DeviceLogSummary = {
      id: syntheticId--,
      deviceId: payload.deviceId,
      sequence: payload.sequence ?? null,
      level: payload.level,
      code: payload.code,
      message: payload.message,
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? null,
      hardwareId: payload.hardwareId ?? null,
      deviceTimestamp: payload.timestamp ?? null,
      metadata: payload.metadata ?? null,
      receivedAt,
    };
    const activity: DeviceActivitySummary = {
      id: `optimistic-log:${messageId}`,
      deviceId: payload.deviceId,
      sequence: payload.sequence ?? null,
      kind: "lifecycle",
      title: payload.code || payload.level.toUpperCase(),
      message: payload.message,
      state: null,
      level: payload.level,
      code: payload.code,
      delta: null,
      eventTimestamp: payload.timestamp ?? null,
      receivedAt,
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? null,
      hardwareId: payload.hardwareId ?? null,
      metadata: payload.metadata ?? null,
    };

    optimisticLogByMessageId.set(messageId, { messageId, log, activity });
    pushLog(log);
    pushActivity(activity);
    return {
      devices: [],
      events: [],
      logs: [log],
      activities: [activity],
    };
  }

  return {
    clearOptimisticMessage,
    recordOptimisticMotion,
    recordOptimisticLog,
  };
}
