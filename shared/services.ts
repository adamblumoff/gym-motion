import type {
  ApprovedNodeRule,
  DesktopSnapshot,
  DesktopSetupState,
  DeviceAnalyticsSnapshot,
  DeviceActivitySummary,
  DeviceLogSummary,
  GetDeviceAnalyticsInput,
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
  startManualScan: "runtime:start-manual-scan",
  pairDiscoveredNode: "runtime:pair-discovered-node",
  pairManualCandidate: "runtime:pair-manual-candidate",
  forgetNode: "runtime:forget-node",
  recoverApprovedNode: "runtime:recover-approved-node",
  resumeReconnectForNode: "runtime:resume-reconnect-for-node",
  resumeApprovedNodeReconnect: "runtime:resume-approved-node-reconnect",
  setAllowedNodes: "runtime:set-allowed-nodes",
  getDeviceAnalytics: "runtime:get-device-analytics",
  getDeviceActivity: "runtime:get-device-activity",
  updated: "runtime:updated",
} as const;

export const DESKTOP_GATEWAY_ADMIN_CHANNELS = {
  getConfig: "gateway-admin:get-config",
  saveConfig: "gateway-admin:save-config",
  runCommand: "gateway-admin:run-command",
  checkReadiness: "gateway-admin:check-readiness",
} as const;

export const DESKTOP_THEME_CHANNELS = {
  getState: "theme:get-state",
  setPreference: "theme:set-preference",
  updated: "theme:updated",
} as const;

export type GatewayAdminGateway = {
  id: string;
  label: string;
  sshHostAlias: string | null;
  host: string | null;
  user: string | null;
  port: number;
  serviceName: string;
  repoPath: string;
  notes: string | null;
};

export type GatewayAdminConfig = {
  gateways: GatewayAdminGateway[];
};

export type GatewayAdminCommand = "status" | "start" | "stop" | "restart" | "logs" | "custom";

export type RunGatewayAdminCommandInput = {
  gatewayId: string;
  command: GatewayAdminCommand;
  customCommand?: string;
};

export type GatewayAdminCommandResult = {
  gatewayId: string;
  command: GatewayAdminCommand;
  connectionLabel: string;
  remoteCommand: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  startedAt: string;
  finishedAt: string;
};

export type GatewayAdminReadinessCheck = {
  key:
    | "ssh-client"
    | "ssh-agent"
    | "ssh-connect"
    | "repo-path"
    | "service-control"
    | "logs";
  label: string;
  ok: boolean;
  detail: string;
};

export type GatewayAdminReadinessResult = {
  gatewayId: string;
  checkedAt: string;
  overallOk: boolean;
  connectionLabel: string;
  bootstrapCommand: string;
  checks: GatewayAdminReadinessCheck[];
};

export type DesktopRuntimeBatchPatch = {
  devices?: GatewayRuntimeDeviceSummary[];
  events?: MotionEventSummary[];
  removedEventIds?: Array<number | string>;
  logs?: DeviceLogSummary[];
  removedLogIds?: Array<number | string>;
  activities?: DeviceActivitySummary[];
  removedActivityIds?: Array<number | string>;
  gateway?: {
    gateway: GatewayStatusSummary;
    liveStatus: string;
    runtimeState: DesktopSnapshot["runtimeState"];
    gatewayIssue: string | null;
  };
  replaceSnapshot?: DesktopSnapshot;
};

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
    }
  | {
      type: "runtime-batch";
      patch: DesktopRuntimeBatchPatch;
    }
  | {
      type: "analytics-updated";
      analytics: DeviceAnalyticsSnapshot;
    }
  | {
      type: "analytics-invalidated";
      deviceIds: string[];
    };

export type ThemeState = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
};

export type DesktopApi = {
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSetupState: () => Promise<DesktopSetupState>;
  restartGatewayRuntime: () => Promise<DesktopSnapshot>;
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
  getGatewayAdminConfig: () => Promise<GatewayAdminConfig>;
  saveGatewayAdminConfig: (config: GatewayAdminConfig) => Promise<GatewayAdminConfig>;
  runGatewayAdminCommand: (
    input: RunGatewayAdminCommandInput,
  ) => Promise<GatewayAdminCommandResult>;
  checkGatewayAdminReadiness: (gatewayId: string) => Promise<GatewayAdminReadinessResult>;
  subscribeRuntime: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
  getThemeState: () => Promise<ThemeState>;
  setThemePreference: (preference: ThemePreference) => Promise<ThemeState>;
  subscribeTheme: (listener: (state: ThemeState) => void) => () => void;
};
