import type { GatewayRuntimeDeviceSummary } from "@core/contracts";

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

  return {
    gatewayConnectionState:
      existing?.gatewayConnectionState ??
      (inferredTelemetryTimestamp ? "discovered" : "unreachable"),
    telemetryFreshness:
      existing?.telemetryFreshness ?? (inferredTelemetryTimestamp ? "fresh" : "missing"),
    peripheralId: existing?.peripheralId ?? null,
    gatewayLastAdvertisementAt: existing?.gatewayLastAdvertisementAt ?? null,
    gatewayLastConnectedAt: existing?.gatewayLastConnectedAt ?? null,
    gatewayLastDisconnectedAt: existing?.gatewayLastDisconnectedAt ?? null,
    gatewayLastTelemetryAt: existing?.gatewayLastTelemetryAt ?? inferredTelemetryTimestamp,
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
    ...partialDevice,
  };
}
