import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceSummary,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";

import {
  createEmptySetupState,
  createEmptySnapshot,
  offlineGatewaySnapshot,
} from "./runtime-snapshot";

export const CLOUD_SETUP_MESSAGE =
  "Cloud mode is active. Sensor setup now lives on Linux gateways, so this desktop build is read-only for BLE pairing.";

function approvedRuleFromDevice(device: DeviceSummary): ApprovedNodeRule {
  return {
    id: device.id,
    label: device.machineLabel ?? device.id,
    peripheralId: null,
    address: null,
    localName: null,
    knownDeviceId: device.id,
  };
}

function mapHealthToConnectionState(
  healthStatus: DeviceSummary["healthStatus"],
): GatewayRuntimeDeviceSummary["gatewayConnectionState"] {
  switch (healthStatus) {
    case "online":
    case "stale":
      return "connected";
    default:
      return "disconnected";
  }
}

function mapHealthToFreshness(
  healthStatus: DeviceSummary["healthStatus"],
): GatewayRuntimeDeviceSummary["telemetryFreshness"] {
  switch (healthStatus) {
    case "online":
      return "fresh";
    case "stale":
      return "stale";
    default:
      return "missing";
  }
}

export function mapDeviceToRuntimeSummary(device: DeviceSummary): GatewayRuntimeDeviceSummary {
  return {
    ...device,
    gatewayConnectionState: mapHealthToConnectionState(device.healthStatus),
    telemetryFreshness: mapHealthToFreshness(device.healthStatus),
    sensorIssue: device.healthStatus === "offline" ? "No recent cloud heartbeat." : null,
    peripheralId: null,
    address: null,
    gatewayLastAdvertisementAt: null,
    gatewayLastConnectedAt: device.lastHeartbeatAt ?? device.lastEventReceivedAt,
    gatewayLastDisconnectedAt: device.healthStatus === "offline" ? device.updatedAt : null,
    gatewayLastTelemetryAt: device.lastEventReceivedAt ?? device.lastHeartbeatAt,
    gatewayDisconnectReason:
      device.healthStatus === "offline" ? "No recent gateway update reached the backend." : null,
    advertisedName: device.machineLabel,
    lastRssi: null,
    otaStatus: device.updateStatus,
    otaTargetVersion: device.updateTargetVersion,
    otaProgressBytesSent: null,
    otaTotalBytes: null,
    otaLastPhase: null,
    otaFailureDetail: device.updateStatus === "failed" ? device.updateDetail : null,
    otaLastStatusMessage: device.updateDetail,
    otaUpdatedAt: device.updateUpdatedAt,
    reconnectAttempt: 0,
    reconnectAttemptLimit: 0,
    reconnectRetryExhausted: false,
    reconnectAwaitingDecision: false,
  };
}

export function buildCloudSetup(devices: DeviceSummary[]): DesktopSetupState {
  return {
    ...createEmptySetupState(),
    adapterIssue: CLOUD_SETUP_MESSAGE,
    approvedNodes: devices.map(approvedRuleFromDevice),
  };
}

export function buildCloudSnapshot(baseUrl: string, devices: DeviceSummary[], args: {
  events: DesktopSnapshot["events"];
  activities: DeviceActivitySummary[];
  gatewayIssue: string | null;
}): DesktopSnapshot {
  const runtimeDevices = devices.map(mapDeviceToRuntimeSummary);
  const connectedNodeCount = runtimeDevices.filter(
    (device) => device.gatewayConnectionState === "connected",
  ).length;
  const updatedAtCandidates = [
    ...devices.map((device) => device.updatedAt),
    ...args.events.map((event) => event.receivedAt),
    ...args.activities.map((activity) => activity.receivedAt),
  ]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const gatewayUpdatedAt =
    updatedAtCandidates.length > 0
      ? new Date(Math.max(...updatedAtCandidates)).toISOString()
      : new Date(0).toISOString();
  const gateway = {
    ...offlineGatewaySnapshot(),
    hostname: new URL(baseUrl).hostname,
    mode: "cloud-http-backend",
    sessionId: new URL(baseUrl).host,
    adapterState: "remote",
    scanState: "remote",
    connectedNodeCount,
    reconnectingNodeCount: 0,
    knownNodeCount: runtimeDevices.length,
    updatedAt: gatewayUpdatedAt,
  };
  const runtimeState = args.gatewayIssue ? "degraded" : "running";
  const liveStatus = args.gatewayIssue
    ? "Cloud backend unavailable"
    : connectedNodeCount > 0
      ? "Cloud data live"
      : runtimeDevices.length > 0
        ? "Cloud backend connected"
        : "Waiting for cloud device data";

  return {
    ...createEmptySnapshot(),
    trayHint: "Desktop reads from the cloud backend. BLE runs on Linux gateways.",
    liveStatus,
    runtimeState,
    gatewayIssue: args.gatewayIssue,
    gateway,
    devices: runtimeDevices,
    events: args.events,
    activities: args.activities,
  } satisfies DesktopSnapshot;
}
