import type { z } from "zod";

import type {
  backfillBatchSchema,
  backfillRecordSchema,
  deviceAssignmentSchema,
  deviceLogLevelSchema,
  deviceLogSchema,
  deviceRegistrationSchema,
  firmwareReleaseSchema,
  firmwareReportSchema,
  gatewayConnectionStateSchema,
  healthStatusSchema,
  heartbeatPayloadSchema,
  ingestPayloadSchema,
  motionStateSchema,
  otaRuntimeStatusSchema,
  provisioningStateSchema,
  resolvedThemeSchema,
  telemetryFreshnessSchema,
  themePreferenceSchema,
  updateStatusSchema,
} from "./schemas";

export type MotionState = z.infer<typeof motionStateSchema>;
export type ProvisioningState = z.infer<typeof provisioningStateSchema>;
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type DeviceLogLevel = z.infer<typeof deviceLogLevelSchema>;
export type GatewayConnectionState = z.infer<typeof gatewayConnectionStateSchema>;
export type TelemetryFreshness = z.infer<typeof telemetryFreshnessSchema>;
export type OtaRuntimeStatus = z.infer<typeof otaRuntimeStatusSchema>;
export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type ResolvedTheme = z.infer<typeof resolvedThemeSchema>;
export type IngestPayload = z.infer<typeof ingestPayloadSchema>;
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
export type DeviceAssignmentInput = z.infer<typeof deviceAssignmentSchema>;
export type DeviceRegistrationInput = z.infer<typeof deviceRegistrationSchema>;
export type FirmwareReleaseInput = z.infer<typeof firmwareReleaseSchema>;
export type FirmwareReportInput = z.infer<typeof firmwareReportSchema>;
export type DeviceLogInput = z.infer<typeof deviceLogSchema>;
export type BackfillBatchInput = z.infer<typeof backfillBatchSchema>;
export type BackfillRecordInput = z.infer<typeof backfillRecordSchema>;

export type DeviceSummary = {
  id: string;
  lastState: MotionState;
  lastSeenAt: number;
  lastDelta: number | null;
  updatedAt: string;
  hardwareId: string | null;
  bootId: string | null;
  firmwareVersion: string;
  machineLabel: string | null;
  siteId: string | null;
  provisioningState: ProvisioningState;
  updateStatus: UpdateStatus;
  updateTargetVersion: string | null;
  updateDetail: string | null;
  updateUpdatedAt: string | null;
  lastHeartbeatAt: string | null;
  lastEventReceivedAt: string | null;
  healthStatus: HealthStatus;
};

export type GatewayStatusSummary = {
  hostname: string;
  mode: string;
  sessionId: string;
  adapterState: string;
  scanState: string;
  scanReason?: string | null;
  connectedNodeCount: number;
  reconnectingNodeCount: number;
  knownNodeCount: number;
  startedAt: string;
  updatedAt: string;
  lastAdvertisementAt: string | null;
};

export type GatewayHealthResponse = {
  ok: boolean;
  gateway: GatewayStatusSummary;
  error?: string;
};

export type BleAdapterSummary = {
  id: string;
  label: string;
  transport: "usb" | "hci" | "winrt" | "unknown";
  runtimeDeviceId: number | null;
  isAvailable: boolean;
  issue: string | null;
  details: string[];
};

export type ApprovedNodeRule = {
  id: string;
  label: string;
  peripheralId: string | null;
  address: string | null;
  localName: string | null;
  knownDeviceId: string | null;
};

export type DiscoveredNodeSummary = {
  id: string;
  label: string;
  peripheralId: string | null;
  address: string | null;
  localName: string | null;
  knownDeviceId: string | null;
  machineLabel: string | null;
  siteId: string | null;
  lastRssi: number | null;
  lastSeenAt: string | null;
  gatewayConnectionState: GatewayConnectionState | "visible";
  isApproved: boolean;
};

export type ManualScanState = "idle" | "scanning" | "pairing" | "failed";

export type ManualScanCandidateSummary = {
  id: string;
  label: string;
  peripheralId: string | null;
  address: string | null;
  localName: string | null;
  knownDeviceId: string | null;
  machineLabel: string | null;
  siteId: string | null;
  lastRssi: number | null;
  lastSeenAt: string | null;
};

export type DesktopSetupState = {
  adapterIssue: string | null;
  approvedNodes: ApprovedNodeRule[];
  manualScanState: ManualScanState;
  pairingCandidateId: string | null;
  manualScanError: string | null;
  manualCandidates: ManualScanCandidateSummary[];
};

export type GatewayRuntimeDeviceSummary = DeviceSummary & {
  gatewayConnectionState: GatewayConnectionState;
  telemetryFreshness: TelemetryFreshness;
  peripheralId: string | null;
  address?: string | null;
  gatewayLastAdvertisementAt: string | null;
  gatewayLastConnectedAt: string | null;
  gatewayLastDisconnectedAt: string | null;
  gatewayLastTelemetryAt: string | null;
  gatewayDisconnectReason: string | null;
  advertisedName: string | null;
  lastRssi: number | null;
  otaStatus: OtaRuntimeStatus;
  otaTargetVersion: string | null;
  otaProgressBytesSent: number | null;
  otaTotalBytes: number | null;
  otaLastPhase: string | null;
  otaFailureDetail: string | null;
  otaLastStatusMessage: string | null;
  otaUpdatedAt: string | null;
  reconnectAttempt: number;
  reconnectAttemptLimit: number;
  reconnectRetryExhausted: boolean;
  reconnectAwaitingDecision?: boolean;
};

export type GatewayRuntimeDevicesResponse = {
  ok: boolean;
  gateway: GatewayStatusSummary;
  devices: GatewayRuntimeDeviceSummary[];
  error?: string;
};

export type DeviceCleanupResult = {
  deviceId: string;
  deletedEvents: number;
  deletedDevices: number;
};

export type MotionEventSummary = {
  id: number;
  deviceId: string;
  sequence: number | null;
  state: MotionState;
  delta: number | null;
  eventTimestamp: number;
  receivedAt: string;
  bootId: string | null;
  firmwareVersion: string | null;
  hardwareId: string | null;
};

export function getMotionEventTimelineTimestamp(event: Pick<MotionEventSummary, "receivedAt">) {
  return Date.parse(event.receivedAt);
}

export type DeviceLogSummary = {
  id: number;
  deviceId: string;
  sequence: number | null;
  level: DeviceLogLevel;
  code: string;
  message: string;
  bootId: string | null;
  firmwareVersion: string | null;
  hardwareId: string | null;
  deviceTimestamp: number | null;
  metadata: Record<string, string | number | boolean | null> | null;
  receivedAt: string;
};

export type DeviceActivitySummary = {
  id: string;
  deviceId: string;
  sequence: number | null;
  kind: "motion" | "lifecycle";
  title: string;
  message: string;
  state: MotionState | null;
  level: DeviceLogLevel | null;
  code: string | null;
  delta: number | null;
  eventTimestamp: number | null;
  receivedAt: string;
  bootId: string | null;
  firmwareVersion: string | null;
  hardwareId: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
};

export type AnalyticsWindow = "24h" | "7d";

export type AnalyticsWarningFlag =
  | "history-overflow"
  | "sync-delayed"
  | "sync-failed"
  | "stale-cache";

export type DeviceAnalyticsBucket = {
  key: string;
  label: string;
  startAt: string;
  endAt: string;
  movementCount: number;
  movingSeconds: number;
};

export type DeviceAnalyticsSyncState = {
  deviceId: string;
  state: "idle" | "syncing" | "failed";
  detail: string | null;
  lastCanonicalAt: string | null;
  lastSyncCompletedAt: string | null;
  lastAckedSequence: number;
  lastAckedBootId: string | null;
  lastOverflowDetectedAt: string | null;
};

export type DeviceAnalyticsSnapshot = {
  deviceId: string;
  window: AnalyticsWindow;
  generatedAt: string;
  source: "cache" | "canonical";
  buckets: DeviceAnalyticsBucket[];
  totalMovementCount: number;
  totalMovingSeconds: number;
  warningFlags: AnalyticsWarningFlag[];
  sync: DeviceAnalyticsSyncState;
  liveOverlay?: {
    active: boolean;
    generatedAt: string | null;
    totalMovementCount: number;
    totalMovingSeconds: number;
    lastEventReceivedAt: string | null;
  };
};

export type DesktopSnapshot = {
  liveStatus: string;
  trayHint: string;
  runtimeState: "starting" | "running" | "restarting" | "degraded";
  gatewayIssue: string | null;
  gateway: GatewayStatusSummary;
  devices: GatewayRuntimeDeviceSummary[];
  events: MotionEventSummary[];
  logs: DeviceLogSummary[];
  activities: DeviceActivitySummary[];
};

export type MotionStreamPayload = {
  device: DeviceSummary;
  event?: MotionEventSummary;
};

export type DeviceLogStreamPayload = {
  log: DeviceLogSummary;
};

export type GatewayDeviceStreamPayload = {
  device: GatewayRuntimeDeviceSummary;
};

export type GatewayStatusStreamPayload = GatewayHealthResponse;

export type DeviceActivityResponse = {
  activities: DeviceActivitySummary[];
};

export type DeviceSyncStateSummary = {
  deviceId: string;
  lastAckedSequence: number;
  lastAckedBootId: string | null;
  lastSyncCompletedAt: string | null;
  lastOverflowDetectedAt: string | null;
};

export type FirmwareHistorySyncStateSummary = {
  deviceId: string;
  lastAckedHistorySequence: number;
  lastHistorySyncCompletedAt: string | null;
  lastHistoryOverflowDetectedAt: string | null;
};

export type BackfillBatchResult = {
  insertedEvents: MotionEventSummary[];
  insertedLogs: DeviceLogSummary[];
  syncState: DeviceSyncStateSummary;
  historySyncState: FirmwareHistorySyncStateSummary;
};

export type GetDeviceAnalyticsInput = {
  deviceId: string;
  window: AnalyticsWindow;
};

export type FirmwareReleaseSummary = {
  version: string;
  gitSha: string;
  assetUrl: string;
  sha256: string;
  md5: string | null;
  sizeBytes: number;
  rolloutState: "draft" | "active" | "paused";
  createdAt: string;
};
