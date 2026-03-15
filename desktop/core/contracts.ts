import { z } from "zod";

export const motionStateSchema = z.enum(["moving", "still"]);
export const provisioningStateSchema = z.enum([
  "unassigned",
  "assigned",
  "provisioned",
]);
export const updateStatusSchema = z.enum([
  "idle",
  "available",
  "downloading",
  "applied",
  "booted",
  "failed",
  "rolled_back",
]);
export const healthStatusSchema = z.enum(["online", "stale", "offline"]);
export const deviceLogLevelSchema = z.enum(["info", "warn", "error"]);
export const gatewayConnectionStateSchema = z.enum([
  "discovered",
  "connecting",
  "connected",
  "reconnecting",
  "disconnected",
  "unreachable",
]);
export const telemetryFreshnessSchema = z.enum(["fresh", "stale", "missing"]);
export const otaRuntimeStatusSchema = z.enum([
  "idle",
  "available",
  "downloading",
  "waiting-ready",
  "sending",
  "waiting-applied",
  "applied",
  "booted",
  "failed",
  "rolled_back",
]);
export const themePreferenceSchema = z.enum(["dark", "light", "system"]);
export const resolvedThemeSchema = z.enum(["dark", "light"]);

export const ingestPayloadSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  state: motionStateSchema,
  timestamp: z.number().int().positive(),
  delta: z.number().int().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  bootId: z.string().trim().min(1).max(120).optional(),
  firmwareVersion: z.string().trim().min(1).max(120).optional(),
  hardwareId: z.string().trim().min(1).max(120).optional(),
});

export const heartbeatPayloadSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  timestamp: z.number().int().positive(),
  bootId: z.string().trim().min(1).max(120).optional(),
  firmwareVersion: z.string().trim().min(1).max(120).optional(),
  hardwareId: z.string().trim().min(1).max(120).optional(),
});

export const deviceAssignmentSchema = z.object({
  machineLabel: z.string().trim().min(1).max(120).nullable().optional(),
  siteId: z.string().trim().min(1).max(120).nullable().optional(),
  hardwareId: z.string().trim().min(1).max(120).nullable().optional(),
  provisioningState: provisioningStateSchema.optional(),
});

export const deviceRegistrationSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  machineLabel: z.string().trim().min(1).max(120).nullable().optional(),
  siteId: z.string().trim().min(1).max(120).nullable().optional(),
  hardwareId: z.string().trim().min(1).max(120).nullable().optional(),
  provisioningState: provisioningStateSchema.default("assigned"),
});

export const firmwareReleaseSchema = z.object({
  version: z.string().trim().min(1).max(120),
  gitSha: z.string().trim().min(1).max(120),
  assetUrl: z.string().trim().min(1).max(512),
  sha256: z.string().trim().min(32).max(128),
  md5: z.string().trim().length(32).optional(),
  sizeBytes: z.number().int().positive(),
  rolloutState: z.enum(["draft", "active", "paused"]).default("draft"),
});

export const deviceLogSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  level: deviceLogLevelSchema,
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(280),
  sequence: z.number().int().nonnegative().optional(),
  bootId: z.string().trim().min(1).max(120).optional(),
  firmwareVersion: z.string().trim().min(1).max(120).optional(),
  hardwareId: z.string().trim().min(1).max(120).optional(),
  timestamp: z.number().int().nonnegative().optional(),
  metadata: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ).optional(),
});

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

export type DesktopSetupState = {
  adapterIssue: string | null;
  approvedNodes: ApprovedNodeRule[];
  nodes: DiscoveredNodeSummary[];
};

export type GatewayRuntimeDeviceSummary = DeviceSummary & {
  gatewayConnectionState: GatewayConnectionState;
  telemetryFreshness: TelemetryFreshness;
  peripheralId: string | null;
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

export function normalizeThemePreference(
  value: string | null | undefined,
): ThemePreference {
  const result = themePreferenceSchema.safeParse(value);
  return result.success ? result.data : "dark";
}

export function resolveTheme(
  preference: ThemePreference,
  systemWantsDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemWantsDark ? "dark" : "light";
  }

  return preference;
}

export function mergeGatewayDeviceUpdate(
  devices: GatewayRuntimeDeviceSummary[],
  device: GatewayRuntimeDeviceSummary,
): GatewayRuntimeDeviceSummary[] {
  const nextDevices = [device, ...devices.filter((item) => item.id !== device.id)];

  return nextDevices.sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

export function mergeEventUpdate(
  events: MotionEventSummary[],
  event: MotionEventSummary,
  limit = 12,
): MotionEventSummary[] {
  return [event, ...events.filter((item) => item.id !== event.id)].slice(0, limit);
}

export function mergeLogUpdate(
  logs: DeviceLogSummary[],
  log: DeviceLogSummary,
  limit = 100,
): DeviceLogSummary[] {
  return [log, ...logs.filter((item) => item.id !== log.id)].slice(0, limit);
}

export function mergeActivityUpdate(
  activities: DeviceActivitySummary[],
  activity: DeviceActivitySummary,
  limit = 100,
): DeviceActivitySummary[] {
  return [activity, ...activities.filter((item) => item.id !== activity.id)]
    .toSorted((left, right) => {
      if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence) {
        return right.sequence - left.sequence;
      }

      if (
        left.eventTimestamp !== null &&
        right.eventTimestamp !== null &&
        left.eventTimestamp !== right.eventTimestamp
      ) {
        return right.eventTimestamp - left.eventTimestamp;
      }

      return new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime();
    })
    .slice(0, limit);
}

export function parseIngestPayload(input: unknown) {
  return ingestPayloadSchema.safeParse(input);
}

export function parseHeartbeatPayload(input: unknown) {
  return heartbeatPayloadSchema.safeParse(input);
}

export function parseDeviceAssignment(input: unknown) {
  return deviceAssignmentSchema.safeParse(input);
}

export function parseDeviceRegistration(input: unknown) {
  return deviceRegistrationSchema.safeParse(input);
}

export function parseFirmwareRelease(input: unknown) {
  return firmwareReleaseSchema.safeParse(input);
}

export function parseDeviceLog(input: unknown) {
  return deviceLogSchema.safeParse(input);
}
