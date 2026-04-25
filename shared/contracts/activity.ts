import type {
  DeviceActivitySummary,
  DeviceLogSummary,
  MotionEventSummary,
} from "./types";

export function mapMotionEventToActivity(
  event: MotionEventSummary,
): DeviceActivitySummary {
  return {
    id: `motion-${event.id}`,
    deviceId: event.deviceId,
    gatewayId: event.gatewayId,
    sequence: event.sequence,
    kind: "motion",
    title: event.state.toUpperCase(),
    message: `Gateway recorded ${event.state} for ${event.deviceId}.`,
    state: event.state,
    level: null,
    code: "motion.state",
    delta: event.delta,
    eventTimestamp: event.eventTimestamp,
    receivedAt: event.receivedAt,
    bootId: event.bootId,
    firmwareVersion: event.firmwareVersion,
    hardwareId: event.hardwareId,
    metadata: event.delta === null ? null : { delta: event.delta },
  };
}

export function mapDeviceLogToActivity(log: DeviceLogSummary): DeviceActivitySummary {
  return {
    id: `log-${log.id}`,
    deviceId: log.deviceId,
    gatewayId: log.gatewayId,
    sequence: log.sequence,
    kind: "lifecycle",
    title: log.code ?? log.level.toUpperCase(),
    message: log.message,
    state: null,
    level: log.level,
    code: log.code,
    delta: null,
    eventTimestamp: log.deviceTimestamp,
    receivedAt: log.receivedAt,
    bootId: log.bootId,
    firmwareVersion: log.firmwareVersion,
    hardwareId: log.hardwareId,
    metadata: log.metadata,
  };
}
