import type {
  DeviceActivitySummary,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  MotionEventSummary,
} from "./types";

export function mergeGatewayDeviceUpdate(
  devices: GatewayRuntimeDeviceSummary[],
  device: GatewayRuntimeDeviceSummary,
): GatewayRuntimeDeviceSummary[] {
  const nextDevices = [device, ...devices.filter((item) => item.id !== device.id)];

  return nextDevices.sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

export function mergeEventUpdate(
  events: MotionEventSummary[],
  event: MotionEventSummary,
  limit = 12,
): MotionEventSummary[] {
  return [event, ...events.filter((item) => item.id !== event.id)].slice(0, limit);
}

export function mergeLogUpdate(
  logs: DeviceLogSummary[],
  log: DeviceLogSummary,
  limit = 100,
): DeviceLogSummary[] {
  return [log, ...logs.filter((item) => item.id !== log.id)].slice(0, limit);
}

export function mergeActivityUpdate(
  activities: DeviceActivitySummary[],
  activity: DeviceActivitySummary,
  limit = 100,
): DeviceActivitySummary[] {
  return [activity, ...activities.filter((item) => item.id !== activity.id)]
    .toSorted((left, right) => {
      if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence) {
        return right.sequence - left.sequence;
      }

      if (
        left.eventTimestamp !== null &&
        right.eventTimestamp !== null &&
        left.eventTimestamp !== right.eventTimestamp
      ) {
        return right.eventTimestamp - left.eventTimestamp;
      }

      return new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime();
    })
    .slice(0, limit);
}
