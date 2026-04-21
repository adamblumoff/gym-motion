import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceAnalyticsSnapshot,
  GetDeviceAnalyticsInput,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

export type DesktopRuntime = {
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
  onEvent: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
};
