import type {
  ApprovedNodeRule,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceLogInput,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  IngestPayload,
  MotionEventSummary,
} from "@core/contracts";

import { matchesApprovedNodeRule } from "../setup-selection";

type RuntimeCacheOptions = {
  eventLimit?: number;
  logLimit?: number;
  activityLimit?: number;
  nodeActivityLimit?: number;
};

type RuntimeBatchPatchState = {
  devices: GatewayRuntimeDeviceSummary[];
  events: MotionEventSummary[];
  logs: DeviceLogSummary[];
  activities: DeviceActivitySummary[];
};

type RuntimeCache = {
  getSnapshot: () => DesktopSnapshot;
  replaceSnapshot: (snapshot: DesktopSnapshot) => void;
  updateGateway: (
    gateway: DesktopSnapshot["gateway"],
    runtimeState: DesktopSnapshot["runtimeState"],
    gatewayIssue: string | null,
    liveStatus: string,
  ) => void;
  upsertDevice: (device: GatewayRuntimeDeviceSummary) => void;
  getDevice: (deviceId: string) => GatewayRuntimeDeviceSummary | null;
  recordOptimisticMotion: (
    messageId: string,
    payload: IngestPayload,
  ) => RuntimeBatchPatchState;
  recordOptimisticLog: (
    messageId: string,
    payload: DeviceLogInput,
  ) => RuntimeBatchPatchState;
  clearOptimisticMessage: (messageId: string) => {
    removedEventIds: Array<number | string>;
    removedLogIds: Array<number | string>;
    removedActivityIds: Array<number | string>;
  };
  pushEvent: (event: MotionEventSummary) => void;
  pushLog: (log: DeviceLogSummary) => void;
  pushActivity: (activity: DeviceActivitySummary) => void;
  applyApprovedNodeFilter: (approvedNodes: ApprovedNodeRule[]) => boolean;
};

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

function cloneSnapshot(snapshot: DesktopSnapshot): DesktopSnapshot {
  return {
    ...snapshot,
    gateway: { ...snapshot.gateway },
    devices: [...snapshot.devices],
    events: [...snapshot.events],
    logs: [...snapshot.logs],
    activities: [...snapshot.activities],
  };
}

function sortDevices(devices: GatewayRuntimeDeviceSummary[]) {
  devices.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id),
  );
}

function eventSortValue(event: Pick<MotionEventSummary, "receivedAt" | "id">) {
  return [Date.parse(event.receivedAt), event.id] as const;
}

function logSortValue(log: Pick<DeviceLogSummary, "receivedAt" | "id">) {
  return [Date.parse(log.receivedAt), log.id] as const;
}

function activitySortValue(activity: DeviceActivitySummary) {
  return [
    activity.sequence ?? Number.MIN_SAFE_INTEGER,
    activity.eventTimestamp ?? Number.MIN_SAFE_INTEGER,
    Date.parse(activity.receivedAt),
    activity.id,
  ] as const;
}

function insertMotionEvent(
  events: MotionEventSummary[],
  event: MotionEventSummary,
  limit: number,
) {
  const existingIndex = events.findIndex((item) => item.id === event.id);
  if (existingIndex >= 0) {
    events.splice(existingIndex, 1);
  }

  const [eventTime, eventId] = eventSortValue(event);
  let insertAt = 0;
  while (insertAt < events.length) {
    const [currentTime, currentId] = eventSortValue(events[insertAt]);
    if (eventTime > currentTime || (eventTime === currentTime && eventId > currentId)) {
      break;
    }
    insertAt += 1;
  }

  events.splice(insertAt, 0, event);
  events.length = Math.min(events.length, limit);
}

function insertDeviceLog(logs: DeviceLogSummary[], log: DeviceLogSummary, limit: number) {
  const existingIndex = logs.findIndex((item) => item.id === log.id);
  if (existingIndex >= 0) {
    logs.splice(existingIndex, 1);
  }

  const [logTime, logId] = logSortValue(log);
  let insertAt = 0;
  while (insertAt < logs.length) {
    const [currentTime, currentId] = logSortValue(logs[insertAt]);
    if (logTime > currentTime || (logTime === currentTime && logId > currentId)) {
      break;
    }
    insertAt += 1;
  }

  logs.splice(insertAt, 0, log);
  logs.length = Math.min(logs.length, limit);
}

function insertActivity(
  activities: DeviceActivitySummary[],
  activity: DeviceActivitySummary,
  limit: number,
) {
  const existingIndex = activities.findIndex((item) => item.id === activity.id);
  if (existingIndex >= 0) {
    activities.splice(existingIndex, 1);
  }

  const [activitySequence, activityTimestamp, activityReceivedAt, activityId] =
    activitySortValue(activity);
  let insertAt = 0;
  while (insertAt < activities.length) {
    const [currentSequence, currentTimestamp, currentReceivedAt, currentId] = activitySortValue(
      activities[insertAt],
    );
    if (
      activitySequence > currentSequence ||
      (activitySequence === currentSequence && activityTimestamp > currentTimestamp) ||
      (activitySequence === currentSequence &&
        activityTimestamp === currentTimestamp &&
        activityReceivedAt > currentReceivedAt) ||
      (activitySequence === currentSequence &&
        activityTimestamp === currentTimestamp &&
        activityReceivedAt === currentReceivedAt &&
        activityId > currentId)
    ) {
      break;
    }
    insertAt += 1;
  }

  activities.splice(insertAt, 0, activity);
  activities.length = Math.min(activities.length, limit);
}

function deviceMatchesApprovedNode(
  device: GatewayRuntimeDeviceSummary,
  approvedNodes: ApprovedNodeRule[],
) {
  return approvedNodes.some((approvedNode) =>
    matchesApprovedNodeRule(
      approvedNode,
      {
        knownDeviceId: device.id,
        peripheralId: device.peripheralId,
        address: device.address ?? null,
        localName: device.advertisedName ?? null,
      },
      approvedNodes,
    ),
  );
}

export function createRuntimeCache(
  initialSnapshot: DesktopSnapshot,
  options: RuntimeCacheOptions = {},
): RuntimeCache {
  const eventLimit = options.eventLimit ?? 14;
  const logLimit = options.logLimit ?? 18;
  const activityLimit = options.activityLimit ?? 30;
  const nodeActivityLimit = options.nodeActivityLimit ?? 30;
  let syntheticId = -1;

  let snapshot = cloneSnapshot(initialSnapshot);
  let activitiesByDeviceId = new Map<string, DeviceActivitySummary[]>();
  const optimisticMotionByMessageId = new Map<string, OptimisticMotionRecord>();
  const optimisticLogByMessageId = new Map<string, OptimisticLogRecord>();

  function rebuildActivityIndex() {
    activitiesByDeviceId = new Map();
    for (const activity of snapshot.activities) {
      const entries = activitiesByDeviceId.get(activity.deviceId) ?? [];
      entries.push(activity);
      if (entries.length > nodeActivityLimit) {
        entries.length = nodeActivityLimit;
      }
      activitiesByDeviceId.set(activity.deviceId, entries);
    }
  }

  function trimPerDeviceActivities(deviceId: string) {
    const entries = activitiesByDeviceId.get(deviceId);
    if (!entries) {
      return;
    }

    const nextEntries = snapshot.activities
      .filter((activity) => activity.deviceId === deviceId)
      .slice(0, nodeActivityLimit);

    if (nextEntries.length === 0) {
      activitiesByDeviceId.delete(deviceId);
      return;
    }

    activitiesByDeviceId.set(deviceId, nextEntries);
  }

  function replaceSnapshot(nextSnapshot: DesktopSnapshot) {
    snapshot = cloneSnapshot(nextSnapshot);
    rebuildActivityIndex();
  }

  function getSnapshot() {
    return cloneSnapshot(snapshot);
  }

  function upsertDevice(device: GatewayRuntimeDeviceSummary) {
    const existingIndex = snapshot.devices.findIndex((item) => item.id === device.id);
    if (existingIndex >= 0) {
      snapshot.devices[existingIndex] = device;
    } else {
      snapshot.devices.push(device);
    }
    sortDevices(snapshot.devices);
  }

  function getDevice(deviceId: string) {
    return snapshot.devices.find((device) => device.id === deviceId) ?? null;
  }

  function pushEvent(event: MotionEventSummary) {
    insertMotionEvent(snapshot.events, event, eventLimit);
  }

  function pushLog(log: DeviceLogSummary) {
    insertDeviceLog(snapshot.logs, log, logLimit);
  }

  function pushActivity(activity: DeviceActivitySummary) {
    insertActivity(snapshot.activities, activity, activityLimit);
    trimPerDeviceActivities(activity.deviceId);
  }

  function clearOptimisticMessage(messageId: string) {
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

  function updateGateway(
    gateway: DesktopSnapshot["gateway"],
    runtimeState: DesktopSnapshot["runtimeState"],
    gatewayIssue: string | null,
    liveStatus: string,
  ) {
    snapshot.gateway = { ...gateway };
    snapshot.runtimeState = runtimeState;
    snapshot.gatewayIssue = gatewayIssue;
    snapshot.liveStatus = liveStatus;
  }

  function recordOptimisticMotion(messageId: string, payload: IngestPayload) {
    clearOptimisticMessage(messageId);

    const existingDevice = getDevice(payload.deviceId);
    const batch: RuntimeBatchPatchState = {
      devices: [],
      events: [],
      logs: [],
      activities: [],
    };

    if (existingDevice) {
      const nextDevice: GatewayRuntimeDeviceSummary = {
        ...existingDevice,
        lastState: payload.state,
        lastSeenAt: payload.timestamp,
        lastDelta: payload.delta ?? null,
        updatedAt: new Date().toISOString(),
        bootId: payload.bootId ?? existingDevice.bootId,
        firmwareVersion: payload.firmwareVersion ?? existingDevice.firmwareVersion,
        hardwareId: payload.hardwareId ?? existingDevice.hardwareId,
        lastEventReceivedAt: new Date().toISOString(),
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
      metadata: payload.delta === undefined || payload.delta === null ? null : { delta: payload.delta },
    };

    optimisticMotionByMessageId.set(messageId, { messageId, event, activity });
    pushEvent(event);
    pushActivity(activity);
    batch.events.push(event);
    batch.activities.push(activity);
    return batch;
  }

  function recordOptimisticLog(messageId: string, payload: DeviceLogInput) {
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

  function applyApprovedNodeFilter(approvedNodes: ApprovedNodeRule[]) {
    const nextDevices = snapshot.devices.filter((device) =>
      deviceMatchesApprovedNode(device, approvedNodes),
    );
    if (nextDevices.length === snapshot.devices.length) {
      return false;
    }

    const remainingDeviceIds = new Set(nextDevices.map((device) => device.id));
    snapshot.devices = nextDevices;
    snapshot.events = snapshot.events.filter((event) => remainingDeviceIds.has(event.deviceId));
    snapshot.logs = snapshot.logs.filter((log) => remainingDeviceIds.has(log.deviceId));
    snapshot.activities = snapshot.activities.filter((activity) =>
      remainingDeviceIds.has(activity.deviceId),
    );
    snapshot.gateway = {
      ...snapshot.gateway,
      connectedNodeCount: nextDevices.filter(
        (device) => device.gatewayConnectionState === "connected",
      ).length,
      reconnectingNodeCount: nextDevices.filter((device) =>
        ["connecting", "reconnecting"].includes(device.gatewayConnectionState),
      ).length,
      knownNodeCount: nextDevices.length,
      updatedAt: new Date().toISOString(),
    };
    rebuildActivityIndex();
    return true;
  }

  rebuildActivityIndex();

  return {
    getSnapshot,
    replaceSnapshot,
    updateGateway,
    upsertDevice,
    getDevice,
    recordOptimisticMotion,
    recordOptimisticLog,
    clearOptimisticMessage,
    pushEvent,
    pushLog,
    pushActivity,
    applyApprovedNodeFilter,
  };
}
