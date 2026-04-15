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
  sensorIssue: z.string().trim().min(1).max(120).nullable().optional(),
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
  sequence: z.number().int().nonnegative().optional(),
  bootId: z.string().trim().min(1).max(120).optional(),
  firmwareVersion: z.string().trim().min(1).max(120).optional(),
  hardwareId: z.string().trim().min(1).max(120).optional(),
  timestamp: z.number().int().nonnegative().optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});
