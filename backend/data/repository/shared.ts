import { deriveHealthStatus } from "../device-status";
import type {
  DeviceActivitySummary,
  DeviceLogSummary,
  DeviceSummary,
  FirmwareReleaseSummary,
  MotionEventSummary,
  ProvisioningState,
  UpdateStatus,
} from "../motion";

export type DeviceRow = {
  id: string;
  last_state: DeviceSummary["lastState"];
  last_seen_at: string | number;
  last_delta: number | null;
  updated_at: Date;
  hardware_id: string | null;
  boot_id: string | null;
  firmware_version: string;
  machine_label: string | null;
  site_id: string | null;
  provisioning_state: ProvisioningState;
  update_status: UpdateStatus;
  update_target_version: string | null;
  update_detail: string | null;
  update_reported_at: Date | null;
  last_heartbeat_at: Date | null;
  last_event_received_at: Date | null;
};

export type MotionEventRow = {
  id: string | number;
  device_id: string;
  sequence: string | number | null;
  state: MotionEventSummary["state"];
  delta: number | null;
  event_timestamp: string | number;
  received_at: Date;
  boot_id: string | null;
  firmware_version: string | null;
  hardware_id: string | null;
};

export type DeviceLogRow = {
  id: string | number;
  device_id: string;
  sequence: string | number | null;
  level: DeviceLogSummary["level"];
  code: string;
  message: string;
  boot_id: string | null;
  firmware_version: string | null;
  hardware_id: string | null;
  device_timestamp: string | number | null;
  metadata: DeviceLogSummary["metadata"];
  received_at: Date;
};

export type FirmwareReleaseRow = {
  version: string;
  git_sha: string;
  asset_url: string;
  sha256: string;
  md5: string | null;
  size_bytes: string | number;
  rollout_state: FirmwareReleaseSummary["rolloutState"];
  created_at: Date;
};

export type FirmwareCheckInput = {
  deviceId: string;
  firmwareVersion: string | null;
};

export const DEVICE_SELECT_COLUMNS = `id,
       last_state,
       last_seen_at,
       last_delta,
       updated_at,
       hardware_id,
       boot_id,
       firmware_version,
       machine_label,
       site_id,
       provisioning_state,
       update_status,
       update_target_version,
       update_detail,
       update_reported_at,
       last_heartbeat_at,
       last_event_received_at`;

function toSafeNumber(value: string | number) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isSafeInteger(numericValue)) {
    throw new Error(`Value is not a safe integer: ${value}`);
  }

  return numericValue;
}

export function mapDeviceRow(row: DeviceRow): DeviceSummary {
  const lastContactAt = row.last_heartbeat_at ?? row.last_event_received_at;

  return {
    id: row.id,
    lastState: row.last_state,
    lastSeenAt: toSafeNumber(row.last_seen_at),
    lastDelta: row.last_delta,
    updatedAt: row.updated_at.toISOString(),
    hardwareId: row.hardware_id,
    bootId: row.boot_id,
    firmwareVersion: row.firmware_version,
    machineLabel: row.machine_label,
    siteId: row.site_id,
    provisioningState: row.provisioning_state,
    updateStatus: row.update_status,
    updateTargetVersion: row.update_target_version,
    updateDetail: row.update_detail,
    updateUpdatedAt: row.update_reported_at?.toISOString() ?? null,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    lastEventReceivedAt: row.last_event_received_at?.toISOString() ?? null,
    healthStatus: deriveHealthStatus(lastContactAt?.toISOString() ?? null),
  };
}

export function mapMotionEventRow(row: MotionEventRow): MotionEventSummary {
  return {
    id: toSafeNumber(row.id),
    deviceId: row.device_id,
    sequence: row.sequence === null ? null : toSafeNumber(row.sequence),
    state: row.state,
    delta: row.delta,
    eventTimestamp: toSafeNumber(row.event_timestamp),
    receivedAt: row.received_at.toISOString(),
    bootId: row.boot_id,
    firmwareVersion: row.firmware_version,
    hardwareId: row.hardware_id,
  };
}

export function mapDeviceLogRow(row: DeviceLogRow): DeviceLogSummary {
  return {
    id: toSafeNumber(row.id),
    deviceId: row.device_id,
    sequence: row.sequence === null ? null : toSafeNumber(row.sequence),
    level: row.level,
    code: row.code,
    message: row.message,
    bootId: row.boot_id,
    firmwareVersion: row.firmware_version,
    hardwareId: row.hardware_id,
    deviceTimestamp:
      row.device_timestamp === null ? null : toSafeNumber(row.device_timestamp),
    metadata: row.metadata ?? null,
    receivedAt: row.received_at.toISOString(),
  };
}

export function mapFirmwareReleaseRow(row: FirmwareReleaseRow): FirmwareReleaseSummary {
  return {
    version: row.version,
    gitSha: row.git_sha,
    assetUrl: row.asset_url,
    sha256: row.sha256,
    md5: row.md5,
    sizeBytes: toSafeNumber(row.size_bytes),
    rolloutState: row.rollout_state,
    createdAt: row.created_at.toISOString(),
  };
}

export function mapMotionEventToActivity(event: MotionEventSummary): DeviceActivitySummary {
  return {
    id: `motion-${event.id}`,
    deviceId: event.deviceId,
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

export function sortActivities(
  activities: DeviceActivitySummary[],
  limit: number,
): DeviceActivitySummary[] {
  return activities
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
