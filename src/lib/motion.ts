import { z } from "zod";

export const motionStateSchema = z.enum(["moving", "still"]);

export const ingestPayloadSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  state: motionStateSchema,
  timestamp: z.number().int().positive(),
  delta: z.number().int().nullable().optional(),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;
export type MotionState = z.infer<typeof motionStateSchema>;

export type DeviceSummary = {
  id: string;
  lastState: MotionState;
  lastSeenAt: number;
  lastDelta: number | null;
  updatedAt: string;
};

export type MotionEventSummary = {
  id: number;
  deviceId: string;
  state: MotionState;
  delta: number | null;
  eventTimestamp: number;
  receivedAt: string;
};

export function parseIngestPayload(input: unknown) {
  return ingestPayloadSchema.safeParse(input);
}

export function formatZodError(message: z.ZodError) {
  return message.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
