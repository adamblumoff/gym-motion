import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceAnalyticsSnapshot,
  DeviceActivitySummary,
  GetDeviceAnalyticsInput,
} from "@core/contracts";
import type {
  DesktopRuntimeEvent,
  DesktopTestStepName,
} from "@core/services";

export type ManagedGatewayRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<DesktopSnapshot>;
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSetupState: () => Promise<DesktopSetupState>;
  startManualScan: () => Promise<void>;
  pairDiscoveredNode: (candidateId: string) => Promise<DesktopSetupState>;
  pairManualCandidate: (candidateId: string) => Promise<DesktopSetupState>;
  forgetNode: (nodeId: string) => Promise<DesktopSetupState>;
  recoverApprovedNode: (ruleId: string) => Promise<void>;
  resumeReconnectForNode: (nodeId: string) => Promise<void>;
  resumeApprovedNodeReconnect: (ruleId: string) => Promise<void>;
  setAllowedNodes: (nodes: ApprovedNodeRule[]) => Promise<DesktopSetupState>;
  getDeviceAnalytics: (input: GetDeviceAnalyticsInput) => Promise<DeviceAnalyticsSnapshot>;
  getDeviceActivity: (deviceId: string, limit?: number) => Promise<DeviceActivitySummary[]>;
  runE2eStep: (name: DesktopTestStepName, payload?: unknown) => Promise<unknown>;
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
