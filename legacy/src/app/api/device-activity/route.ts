import { NextResponse } from "next/server";

import { createCorsPreflightResponse, withCors } from "@/lib/api-cors";
import { listDeviceActivity } from "@/lib/repository";

export const runtime = "nodejs";

export function OPTIONS() {
  return createCorsPreflightResponse();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 100;

  if (!deviceId) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "deviceId is required." },
        { status: 400 },
      ),
    );
  }

  if (Number.isNaN(limit) || limit < 1) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "limit must be a positive number." },
        { status: 400 },
      ),
    );
  }

  try {
    const activities = await listDeviceActivity({ deviceId, limit });

    return withCors(
      NextResponse.json(
        { activities },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      ),
    );
  } catch (error) {
    console.error("Failed to load device activity", error);

    return withCors(
      NextResponse.json(
        { ok: false, error: "Failed to load device activity." },
        { status: 500 },
      ),
    );
  }
}
