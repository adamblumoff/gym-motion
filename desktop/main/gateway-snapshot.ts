import type { GatewayRuntimeDeviceSummary } from "@core/contracts";
import type { GatewayChildRuntimeDeviceMessage } from "./managed-gateway-runtime/gateway-child-ipc";

type PartialRepositoryDevice = {
  id: string;
  lastState: GatewayRuntimeDeviceSummary["lastState"];
  lastSeenAt: number;
  lastDelta: number | null;
  updatedAt: string;
  hardwareId: string | null;
  bootId: string | null;
  firmwareVersion: string;
  machineLabel: string | null;
  siteId: string | null;
  provisioningState: GatewayRuntimeDeviceSummary["provisioningState"];
  updateStatus: GatewayRuntimeDeviceSummary["updateStatus"];
  updateTargetVersion: string | null;
  updateDetail: string | null;
  updateUpdatedAt: string | null;
  lastHeartbeatAt: string | null;
  lastEventReceivedAt: string | null;
  healthStatus: GatewayRuntimeDeviceSummary["healthStatus"];
};

export function mergeRepositoryDeviceIntoGatewaySnapshot(
  currentDevices: GatewayRuntimeDeviceSummary[],
  partialDevice: PartialRepositoryDevice,
): GatewayRuntimeDeviceSummary {
  const existing = currentDevices.find((device) => device.id === partialDevice.id) ?? null;
  const inferredTelemetryTimestamp =
    partialDevice.lastEventReceivedAt ?? partialDevice.lastHeartbeatAt ?? null;
  const existingTelemetryTime = existing?.gatewayLastTelemetryAt
    ? Date.parse(existing.gatewayLastTelemetryAt)
    : Number.NEGATIVE_INFINITY;
  const inferredTelemetryTime = inferredTelemetryTimestamp
    ? Date.parse(inferredTelemetryTimestamp)
    : Number.NEGATIVE_INFINITY;
  const hasNewerTelemetry = Number.isFinite(inferredTelemetryTime)
    ? inferredTelemetryTime >= existingTelemetryTime
    : false;

  return {
    gatewayConnectionState:
      existing?.gatewayConnectionState ?? "disconnected",
    telemetryFreshness: hasNewerTelemetry
      ? "fresh"
      : existing?.telemetryFreshness ?? (inferredTelemetryTimestamp ? "fresh" : "missing"),
    sensorIssue: existing?.sensorIssue ?? null,
    peripheralId: existing?.peripheralId ?? null,
    address: existing?.address ?? null,
    gatewayLastAdvertisementAt: existing?.gatewayLastAdvertisementAt ?? null,
    gatewayLastConnectedAt: existing?.gatewayLastConnectedAt ?? null,
    gatewayLastDisconnectedAt: existing?.gatewayLastDisconnectedAt ?? null,
    gatewayLastTelemetryAt: hasNewerTelemetry
      ? inferredTelemetryTimestamp
      : existing?.gatewayLastTelemetryAt ?? inferredTelemetryTimestamp,
    gatewayDisconnectReason: existing?.gatewayDisconnectReason ?? null,
    advertisedName: existing?.advertisedName ?? null,
    lastRssi: existing?.lastRssi ?? null,
    otaStatus: existing?.otaStatus ?? "idle",
    otaTargetVersion: existing?.otaTargetVersion ?? null,
    otaProgressBytesSent: existing?.otaProgressBytesSent ?? null,
    otaTotalBytes: existing?.otaTotalBytes ?? null,
    otaLastPhase: existing?.otaLastPhase ?? null,
    otaFailureDetail: existing?.otaFailureDetail ?? null,
    otaLastStatusMessage: existing?.otaLastStatusMessage ?? null,
    otaUpdatedAt: existing?.otaUpdatedAt ?? null,
    reconnectAttempt: existing?.reconnectAttempt ?? 0,
    reconnectAttemptLimit: existing?.reconnectAttemptLimit ?? 20,
    reconnectRetryExhausted: existing?.reconnectRetryExhausted ?? false,
    ...partialDevice,
  };
}

export function mergeRuntimeDeviceIntoGatewaySnapshot(
  currentDevices: GatewayRuntimeDeviceSummary[],
  runtimeDevice: GatewayChildRuntimeDeviceMessage["device"],
): GatewayRuntimeDeviceSummary {
  const existing = currentDevices.find((device) => device.id === runtimeDevice.deviceId) ?? null;
  const telemetryFreshness =
    runtimeDevice.gatewayLastTelemetryAt !== null
      ? "fresh"
      : existing?.telemetryFreshness ?? "missing";

  return {
    id: runtimeDevice.deviceId,
    lastState: runtimeDevice.lastState ?? existing?.lastState ?? "still",
    lastSeenAt: runtimeDevice.lastSeenAt ?? existing?.lastSeenAt ?? 0,
    lastDelta: runtimeDevice.lastDelta ?? existing?.lastDelta ?? null,
    updatedAt: runtimeDevice.updatedAt,
    hardwareId: runtimeDevice.hardwareId ?? existing?.hardwareId ?? null,
    bootId: runtimeDevice.bootId ?? existing?.bootId ?? null,
    firmwareVersion: runtimeDevice.firmwareVersion ?? existing?.firmwareVersion ?? "unknown",
    machineLabel: existing?.machineLabel ?? null,
    siteId: existing?.siteId ?? null,
    provisioningState: existing?.provisioningState ?? "assigned",
    updateStatus: existing?.updateStatus ?? "idle",
    updateTargetVersion: existing?.updateTargetVersion ?? null,
    updateDetail: existing?.updateDetail ?? null,
    updateUpdatedAt: existing?.updateUpdatedAt ?? null,
    lastHeartbeatAt: existing?.lastHeartbeatAt ?? null,
    lastEventReceivedAt: existing?.lastEventReceivedAt ?? null,
    healthStatus:
      existing?.healthStatus ??
      (runtimeDevice.gatewayConnectionState === "connected" ? "online" : "offline"),
    gatewayConnectionState: runtimeDevice.gatewayConnectionState,
    telemetryFreshness,
    peripheralId: runtimeDevice.peripheralId,
    address: runtimeDevice.address,
    gatewayLastAdvertisementAt: runtimeDevice.gatewayLastAdvertisementAt,
    gatewayLastConnectedAt: runtimeDevice.gatewayLastConnectedAt,
    gatewayLastDisconnectedAt: runtimeDevice.gatewayLastDisconnectedAt,
    gatewayLastTelemetryAt: runtimeDevice.gatewayLastTelemetryAt,
    gatewayDisconnectReason: runtimeDevice.gatewayDisconnectReason,
    advertisedName: runtimeDevice.advertisedName,
    lastRssi: runtimeDevice.lastRssi,
    sensorIssue: runtimeDevice.sensorIssue ?? existing?.sensorIssue ?? null,
    otaStatus: runtimeDevice.otaStatus,
    otaTargetVersion: runtimeDevice.otaTargetVersion,
    otaProgressBytesSent: runtimeDevice.otaProgressBytesSent,
    otaTotalBytes: runtimeDevice.otaTotalBytes,
    otaLastPhase: runtimeDevice.otaLastPhase,
    otaFailureDetail: runtimeDevice.otaFailureDetail,
    otaLastStatusMessage: runtimeDevice.otaLastStatusMessage,
    otaUpdatedAt: runtimeDevice.otaUpdatedAt,
    reconnectAttempt: runtimeDevice.reconnectAttempt,
    reconnectAttemptLimit: runtimeDevice.reconnectAttemptLimit,
    reconnectRetryExhausted: runtimeDevice.reconnectRetryExhausted,
    reconnectAwaitingDecision: runtimeDevice.reconnectAwaitingDecision,
  };
}
