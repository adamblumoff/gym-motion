import type {
  ApprovedNodeRule,
  DesktopSnapshot,
  DesktopSetupState,
  DeviceActivitySummary,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  MotionEventSummary,
  ResolvedTheme,
  ThemePreference,
} from "./contracts";

export const DESKTOP_RUNTIME_CHANNELS = {
  getSnapshot: "runtime:get-snapshot",
  getSetupState: "runtime:get-setup-state",
  restartGatewayRuntime: "runtime:restart-gateway-runtime",
  rescanAdapters: "runtime:rescan-adapters",
  requestSilentReconnect: "runtime:request-silent-reconnect",
  recoverApprovedNode: "runtime:recover-approved-node",
  resumeApprovedNodeReconnect: "runtime:resume-approved-node-reconnect",
  setAllowedNodes: "runtime:set-allowed-nodes",
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
  rescanAdapters: () => Promise<DesktopSetupState>;
  requestSilentReconnect: () => Promise<void>;
  recoverApprovedNode: (ruleId: string) => Promise<void>;
  resumeApprovedNodeReconnect: (ruleId: string) => Promise<void>;
  setAllowedNodes: (nodes: ApprovedNodeRule[]) => Promise<DesktopSetupState>;
  subscribeRuntime: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
  getThemeState: () => Promise<ThemeState>;
  setThemePreference: (preference: ThemePreference) => Promise<ThemeState>;
  subscribeTheme: (listener: (state: ThemeState) => void) => () => void;
};
