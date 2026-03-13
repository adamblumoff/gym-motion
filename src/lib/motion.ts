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

export const ingestPayloadSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  state: motionStateSchema,
  timestamp: z.number().int().positive(),
  delta: z.number().int().nullable().optional(),
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

export const firmwareReportSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  status: updateStatusSchema,
  targetVersion: z.string().trim().min(1).max(120).optional(),
  detail: z.string().trim().min(1).max(280).optional(),
});

export const deviceLogSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  level: deviceLogLevelSchema,
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(280),
  bootId: z.string().trim().min(1).max(120).optional(),
  firmwareVersion: z.string().trim().min(1).max(120).optional(),
  hardwareId: z.string().trim().min(1).max(120).optional(),
  timestamp: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
  ])).optional(),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
export type DeviceAssignmentInput = z.infer<typeof deviceAssignmentSchema>;
export type DeviceRegistrationInput = z.infer<typeof deviceRegistrationSchema>;
export type FirmwareReleaseInput = z.infer<typeof firmwareReleaseSchema>;
export type FirmwareReportInput = z.infer<typeof firmwareReportSchema>;
export type DeviceLogInput = z.infer<typeof deviceLogSchema>;
export type MotionState = z.infer<typeof motionStateSchema>;
export type ProvisioningState = z.infer<typeof provisioningStateSchema>;
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type DeviceLogLevel = z.infer<typeof deviceLogLevelSchema>;
export type GatewayConnectionState = z.infer<typeof gatewayConnectionStateSchema>;

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

export type GatewayRuntimeDeviceSummary = DeviceSummary & {
  gatewayConnectionState: GatewayConnectionState;
  peripheralId: string | null;
  gatewayLastAdvertisementAt: string | null;
  gatewayLastConnectedAt: string | null;
  gatewayLastDisconnectedAt: string | null;
  gatewayLastTelemetryAt: string | null;
  gatewayDisconnectReason: string | null;
  advertisedName: string | null;
  lastRssi: number | null;
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

export function mergeDeviceUpdate(
  devices: DeviceSummary[],
  device: DeviceSummary,
): DeviceSummary[] {
  const nextDevices = [device, ...devices.filter((item) => item.id !== device.id)];

  return nextDevices.sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
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

export function parseFirmwareReport(input: unknown) {
  return firmwareReportSchema.safeParse(input);
}

export function parseDeviceLog(input: unknown) {
  return deviceLogSchema.safeParse(input);
}

export function mergeLogUpdate(
  logs: DeviceLogSummary[],
  log: DeviceLogSummary,
  limit = 100,
): DeviceLogSummary[] {
  return [log, ...logs.filter((item) => item.id !== log.id)].slice(0, limit);
}

export function formatZodError(message: z.ZodError) {
  return message.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
