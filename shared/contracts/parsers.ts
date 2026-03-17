import type { z } from "zod";

import {
  backfillBatchSchema,
  deviceAssignmentSchema,
  deviceLogSchema,
  deviceRegistrationSchema,
  firmwareReleaseSchema,
  firmwareReportSchema,
  heartbeatPayloadSchema,
  ingestPayloadSchema,
} from "./schemas";

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

export function parseBackfillBatch(input: unknown) {
  return backfillBatchSchema.safeParse(input);
}

export function formatZodError(message: z.ZodError) {
  return message.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
