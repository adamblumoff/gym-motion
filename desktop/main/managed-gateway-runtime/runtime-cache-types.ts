import type {
  ApprovedNodeRule,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceLogInput,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  IngestPayload,
  MotionEventSummary,
} from "@core/contracts";

export type RuntimeCacheOptions = {
  eventLimit?: number;
  logLimit?: number;
  activityLimit?: number;
  nodeActivityLimit?: number;
};

export type RuntimeBatchPatchState = {
  devices: GatewayRuntimeDeviceSummary[];
  events: MotionEventSummary[];
  logs: DeviceLogSummary[];
  activities: DeviceActivitySummary[];
};

export type RuntimeCache = {
  getSnapshot: () => DesktopSnapshot;
  replaceSnapshot: (snapshot: DesktopSnapshot) => void;
  updateGateway: (
    gateway: DesktopSnapshot["gateway"],
    runtimeState: DesktopSnapshot["runtimeState"],
    gatewayIssue: string | null,
    liveStatus: string,
  ) => void;
  upsertDevice: (device: GatewayRuntimeDeviceSummary) => void;
  getDevice: (deviceId: string) => GatewayRuntimeDeviceSummary | null;
  recordOptimisticMotion: (
    messageId: string,
    payload: IngestPayload,
  ) => RuntimeBatchPatchState;
  recordOptimisticLog: (
    messageId: string,
    payload: DeviceLogInput,
  ) => RuntimeBatchPatchState;
  clearOptimisticMessage: (messageId: string) => {
    removedEventIds: Array<number | string>;
    removedLogIds: Array<number | string>;
    removedActivityIds: Array<number | string>;
  };
  pushEvent: (event: MotionEventSummary) => void;
  pushLog: (log: DeviceLogSummary) => void;
  pushActivity: (activity: DeviceActivitySummary) => void;
  applyApprovedNodeFilter: (approvedNodes: ApprovedNodeRule[]) => boolean;
};

