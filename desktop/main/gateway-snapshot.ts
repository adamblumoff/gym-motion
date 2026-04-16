import {
  mergeGatewayDeviceUpdate,
  type GatewayRuntimeDeviceSummary,
} from "@core/contracts";

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
    gatewayConnectionState: existing?.gatewayConnectionState ?? "disconnected",
    telemetryFreshness: hasNewerTelemetry
      ? "fresh"
      : existing?.telemetryFreshness ?? (inferredTelemetryTimestamp ? "fresh" : "missing"),
    // Repository refreshes do not know about live sensor faults. Let runtime telemetry own this.
    sensorIssue: null,
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

export function applyRepositoryDeviceToGatewaySnapshot(
  currentDevices: GatewayRuntimeDeviceSummary[],
  partialDevice: PartialRepositoryDevice,
) {
  const device = mergeRepositoryDeviceIntoGatewaySnapshot(currentDevices, partialDevice);
  return {
    device,
    devices: mergeGatewayDeviceUpdate(currentDevices, device),
  };
}
