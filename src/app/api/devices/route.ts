import { NextResponse } from "next/server";

import { createCorsPreflightResponse, withCors } from "@/lib/api-cors";
import {
  formatZodError,
  parseDeviceRegistration,
} from "@/lib/motion";
import { broadcastMotionUpdate } from "@/lib/motion-stream";
import {
  createOrUpdateDeviceRegistration,
  listDevices,
} from "@/lib/repository";

export const runtime = "nodejs";

export function OPTIONS() {
  return createCorsPreflightResponse();
}

export async function GET() {
  try {
    const devices = await listDevices();

    return withCors(
      NextResponse.json(
        { devices },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      ),
    );
  } catch (error) {
    console.error("Failed to load devices", error);

    return withCors(
      NextResponse.json(
        { ok: false, error: "Failed to load devices." },
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

  const parsedPayload = parseDeviceRegistration(payload);

  if (!parsedPayload.success) {
    return withCors(
      NextResponse.json(
        { ok: false, error: formatZodError(parsedPayload.error) },
        { status: 400 },
      ),
    );
  }

  try {
    const device = await createOrUpdateDeviceRegistration(parsedPayload.data);
    broadcastMotionUpdate({ device });

    return withCors(NextResponse.json({ ok: true, device }));
  } catch (error) {
    console.error("Failed to register device", error);

    return withCors(
      NextResponse.json(
        { ok: false, error: "Failed to register device." },
        { status: 500 },
      ),
    );
  }
}
