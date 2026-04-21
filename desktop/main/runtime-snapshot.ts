import type { DesktopSetupState, DesktopSnapshot, GatewayStatusSummary } from "@core/contracts";
import { liveStatusLabelForScan } from "@core/gateway-scan";

export const EMPTY_GATEWAY: GatewayStatusSummary = {
  hostname: "unavailable",
  mode: "reference-ble-node-gateway",
  sessionId: "unavailable",
  adapterState: "unknown",
  scanState: "stopped",
  scanReason: null,
  connectedNodeCount: 0,
  reconnectingNodeCount: 0,
  knownNodeCount: 0,
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date().toISOString(),
  lastAdvertisementAt: null,
};

export function createEmptySnapshot(): DesktopSnapshot {
  return {
    liveStatus: "Starting gateway runtime...",
    trayHint: "Closes to tray. Runtime stays hot.",
    runtimeState: "starting",
    gatewayIssue: null,
    gateway: { ...EMPTY_GATEWAY },
    devices: [],
    events: [],
    logs: [],
    activities: [],
  };
}

export function offlineGatewaySnapshot() {
  return {
    ...EMPTY_GATEWAY,
    updatedAt: new Date().toISOString(),
  };
}

export function createEmptySetupState(): DesktopSetupState {
  return {
    adapterIssue: null,
    approvedNodes: [],
    manualScanState: "idle",
    pairingCandidateId: null,
    manualScanError: null,
    manualCandidates: [],
  };
}

export function liveStatusFor(snapshotState: DesktopSnapshot) {
  if (snapshotState.runtimeState === "starting") {
    return "Starting gateway runtime...";
  }

  if (snapshotState.runtimeState === "restarting") {
    return "Restarting gateway runtime...";
  }

  if (snapshotState.runtimeState === "degraded") {
    return "Gateway degraded";
  }

  if (snapshotState.gateway.connectedNodeCount > 0) {
    return "Gateway live";
  }

  const scanStatusLabel = liveStatusLabelForScan(
    snapshotState.gateway.scanState,
    snapshotState.gateway.scanReason,
    snapshotState.gateway.reconnectingNodeCount,
  );
  if (scanStatusLabel) {
    return scanStatusLabel;
  }

  if (snapshotState.gateway.adapterState !== "poweredOn") {
    return "Waiting for BLE adapter";
  }

  return "Waiting for approved BLE nodes";
}
