import { NextResponse } from "next/server";

import { createCorsPreflightResponse, withCors } from "@/lib/api-cors";
import { broadcastDeviceLog } from "@/lib/motion-stream";
import { formatZodError, parseDeviceLog } from "@/lib/motion";
import { listDeviceLogs, recordDeviceLog } from "@/lib/repository";

export const runtime = "nodejs";

export function OPTIONS() {
  return createCorsPreflightResponse();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 100;

  if (Number.isNaN(limit) || limit < 1) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "limit must be a positive number." },
        { status: 400 },
      ),
    );
  }

  try {
    const logs = await listDeviceLogs({
      deviceId,
      limit,
    });

    return withCors(
      NextResponse.json(
        { logs },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      ),
    );
  } catch (error) {
    console.error("Failed to load device logs", error);

    return withCors(
      NextResponse.json(
        { ok: false, error: "Failed to load device logs." },
        { status: 500 },
      ),
    );
  }
}

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

  const parsedPayload = parseDeviceLog(payload);

  if (!parsedPayload.success) {
    return withCors(
      NextResponse.json(
        { ok: false, error: formatZodError(parsedPayload.error) },
        { status: 400 },
      ),
    );
  }

  try {
    const log = await recordDeviceLog(parsedPayload.data);
    broadcastDeviceLog({ log });

    return withCors(NextResponse.json({ ok: true, log }));
  } catch (error) {
    console.error("Failed to store device log", error);

    return withCors(
      NextResponse.json(
        { ok: false, error: "Failed to store device log." },
        { status: 500 },
      ),
    );
  }
}
