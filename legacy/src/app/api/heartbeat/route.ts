import { NextResponse } from "next/server";

import { formatZodError, parseHeartbeatPayload } from "@/lib/motion";
import { broadcastMotionUpdate } from "@/lib/motion-stream";
import { recordHeartbeat } from "@/lib/repository";

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

  const parsedPayload = parseHeartbeatPayload(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { ok: false, error: formatZodError(parsedPayload.error) },
      { status: 400 },
    );
  }

  try {
    const deviceUpdate = await recordHeartbeat(parsedPayload.data);
    broadcastMotionUpdate(deviceUpdate);
  } catch (error) {
    console.error("Failed to store heartbeat", error);

    return NextResponse.json(
      { ok: false, error: "Failed to store heartbeat." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
