import type { DeviceActivitySummary, DeviceLogSummary, MotionEventSummary } from "@core/contracts";

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

export function createRuntimeCacheActivityStore({
  getMutableSnapshot,
  eventLimit,
  logLimit,
  activityLimit,
  nodeActivityLimit,
}: {
  getMutableSnapshot: () => {
    events: MotionEventSummary[];
    logs: DeviceLogSummary[];
    activities: DeviceActivitySummary[];
  };
  eventLimit: number;
  logLimit: number;
  activityLimit: number;
  nodeActivityLimit: number;
}) {
  let activitiesByDeviceId = new Map<string, DeviceActivitySummary[]>();

  function rebuildActivityIndex() {
    const snapshot = getMutableSnapshot();
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

    const snapshot = getMutableSnapshot();
    const nextEntries = snapshot.activities
      .filter((activity) => activity.deviceId === deviceId)
      .slice(0, nodeActivityLimit);

    if (nextEntries.length === 0) {
      activitiesByDeviceId.delete(deviceId);
      return;
    }

    activitiesByDeviceId.set(deviceId, nextEntries);
  }

  function pushEvent(event: MotionEventSummary) {
    insertMotionEvent(getMutableSnapshot().events, event, eventLimit);
  }

  function pushLog(log: DeviceLogSummary) {
    insertDeviceLog(getMutableSnapshot().logs, log, logLimit);
  }

  function pushActivity(activity: DeviceActivitySummary) {
    insertActivity(getMutableSnapshot().activities, activity, activityLimit);
    trimPerDeviceActivities(activity.deviceId);
  }

  return {
    rebuildActivityIndex,
    trimPerDeviceActivities,
    pushEvent,
    pushLog,
    pushActivity,
  };
}
