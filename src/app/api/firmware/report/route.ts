import { NextResponse } from "next/server";

import { formatZodError, parseFirmwareReport } from "@/lib/motion";
import { broadcastMotionUpdate } from "@/lib/motion-stream";
import { recordFirmwareReport } from "@/lib/repository";

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

  const parsedPayload = parseFirmwareReport(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { ok: false, error: formatZodError(parsedPayload.error) },
      { status: 400 },
    );
  }

  try {
    const device = await recordFirmwareReport(
      parsedPayload.data.deviceId,
      parsedPayload.data.status,
      parsedPayload.data.targetVersion,
      parsedPayload.data.detail,
    );

    if (!device) {
      return NextResponse.json(
        { ok: false, error: "Device not found." },
        { status: 404 },
      );
    }

    broadcastMotionUpdate({ device });

    return NextResponse.json({ ok: true, device });
  } catch (error) {
    console.error("Failed to store firmware report", error);

    return NextResponse.json(
      { ok: false, error: "Failed to store firmware report." },
      { status: 500 },
    );
  }
}
