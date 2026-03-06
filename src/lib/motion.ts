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
  lastSeenAt: string;
  lastDelta: number | null;
};

export function parseIngestPayload(input: unknown) {
  return ingestPayloadSchema.safeParse(input);
}

export function toEventDate(timestamp: number) {
  const eventDate = new Date(timestamp);

  if (Number.isNaN(eventDate.getTime())) {
    throw new Error("Invalid timestamp.");
  }

  return eventDate;
}

export function formatZodError(message: z.ZodError) {
  return message.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}
