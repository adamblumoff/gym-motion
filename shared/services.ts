import type {
  ApprovedNodeRule,
  DesktopSnapshot,
  DesktopSetupState,
  DeviceMovementAnalyticsResult,
  DeviceActivitySummary,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  MovementAnalyticsRange,
  MotionEventSummary,
  ResolvedTheme,
  ThemePreference,
} from "./contracts";

export const DESKTOP_RUNTIME_CHANNELS = {
  getSnapshot: "runtime:get-snapshot",
  getSetupState: "runtime:get-setup-state",
  restartGatewayRuntime: "runtime:restart-gateway-runtime",
  startManualScan: "runtime:start-manual-scan",
  pairDiscoveredNode: "runtime:pair-discovered-node",
  pairManualCandidate: "runtime:pair-manual-candidate",
  forgetNode: "runtime:forget-node",
  recoverApprovedNode: "runtime:recover-approved-node",
  resumeReconnectForNode: "runtime:resume-reconnect-for-node",
  resumeApprovedNodeReconnect: "runtime:resume-approved-node-reconnect",
  setAllowedNodes: "runtime:set-allowed-nodes",
  getDeviceAnalytics: "runtime:get-device-analytics",
  refreshDeviceAnalytics: "runtime:refresh-device-analytics",
  deleteDeviceAnalyticsHistory: "runtime:delete-device-analytics-history",
  updated: "runtime:updated",
} as const;

export const DESKTOP_THEME_CHANNELS = {
  getState: "theme:get-state",
  setPreference: "theme:set-preference",
  updated: "theme:updated",
} as const;

export type DesktopRuntimeEvent =
  | {
      type: "snapshot";
      snapshot: DesktopSnapshot;
    }
  | {
      type: "setup-updated";
      setup: DesktopSetupState;
    }
  | {
      type: "gateway-updated";
      gateway: GatewayStatusSummary;
      liveStatus: string;
      runtimeState: DesktopSnapshot["runtimeState"];
      gatewayIssue: string | null;
    }
  | {
      type: "device-upserted";
      device: GatewayRuntimeDeviceSummary;
    }
  | {
      type: "event-recorded";
      event: MotionEventSummary;
    }
  | {
      type: "log-recorded";
      log: DeviceLogSummary;
    }
  | {
      type: "activity-recorded";
      activity: DeviceActivitySummary;
    };

export type ThemeState = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
};

export type DesktopApi = {
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSetupState: () => Promise<DesktopSetupState>;
  restartGatewayRuntime: () => Promise<DesktopSnapshot>;
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
  deleteDeviceAnalyticsHistory: (deviceId: string) => Promise<{ ok: true }>;
  subscribeRuntime: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
  getThemeState: () => Promise<ThemeState>;
  setThemePreference: (preference: ThemePreference) => Promise<ThemeState>;
  subscribeTheme: (listener: (state: ThemeState) => void) => () => void;
};
