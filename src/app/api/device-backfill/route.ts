import { NextResponse } from "next/server";

import { broadcastDeviceLog, broadcastMotionUpdate } from "@/lib/motion-stream";
import { formatZodError, parseBackfillBatch } from "@/lib/motion";
import { recordBackfillBatch } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const parsedPayload = parseBackfillBatch(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { ok: false, error: formatZodError(parsedPayload.error) },
      { status: 400 },
    );
  }

  try {
    const result = await recordBackfillBatch(parsedPayload.data);

    for (const event of result.insertedEvents) {
      broadcastMotionUpdate({
        device: {
          id: parsedPayload.data.deviceId,
          lastState: event.state,
          lastSeenAt: event.eventTimestamp,
          lastDelta: event.delta,
          updatedAt: new Date().toISOString(),
          hardwareId: event.hardwareId,
          bootId: event.bootId,
          firmwareVersion: event.firmwareVersion ?? "unknown",
          machineLabel: null,
          siteId: null,
          provisioningState: "provisioned",
          updateStatus: "idle",
          lastHeartbeatAt: null,
          lastEventReceivedAt: event.receivedAt,
          healthStatus: "online",
        },
        event,
      });
    }

    for (const log of result.insertedLogs) {
      broadcastDeviceLog({ log });
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Failed to store device backfill", error);

    return NextResponse.json(
      { ok: false, error: "Failed to store device backfill." },
      { status: 500 },
    );
  }
}
