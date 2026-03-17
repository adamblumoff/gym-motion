import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceMovementAnalyticsResult,
  MovementAnalyticsRange,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

export type ManagedGatewayRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<DesktopSnapshot>;
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSetupState: () => Promise<DesktopSetupState>;
  startManualScan: () => Promise<DesktopSetupState>;
  pairDiscoveredNode: (candidateId: string) => Promise<DesktopSetupState>;
  pairManualCandidate: (candidateId: string) => Promise<DesktopSetupState>;
  forgetNode: (nodeId: string) => Promise<DesktopSetupState>;
  recoverApprovedNode: (ruleId: string) => Promise<void>;
  resumeReconnectForNode: (nodeId: string) => Promise<void>;
  resumeApprovedNodeReconnect: (ruleId: string) => Promise<void>;
  setAllowedNodes: (nodes: ApprovedNodeRule[]) => Promise<DesktopSetupState>;
  getDeviceAnalytics: (
    deviceId: string,
    range: MovementAnalyticsRange,
  ) => Promise<DeviceMovementAnalyticsResult>;
  refreshDeviceAnalytics: (
    deviceId: string,
    range: MovementAnalyticsRange,
  ) => Promise<DeviceMovementAnalyticsResult>;
  requestDeviceHistorySync: (deviceId: string) => Promise<{ ok: true }>;
  deleteDeviceAnalyticsHistory: (deviceId: string) => Promise<{ ok: true }>;
  onEvent: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
};

export type ManualScanPayload = {
  state?: DesktopSetupState["manualScanState"];
  pairingCandidateId?: string | null;
  error?: string | null;
  candidates?: DesktopSetupState["manualCandidates"];
};

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-store",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }

  return (await response.json()) as T;
}
