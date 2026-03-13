import { NextResponse } from "next/server";

import { withCors, createCorsPreflightResponse } from "@/lib/api-cors";
import { listRecentEvents } from "@/lib/repository";

export const runtime = "nodejs";

export function OPTIONS() {
  return createCorsPreflightResponse();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") ?? "12");

  if (Number.isNaN(limit) || limit < 1) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "limit must be a positive number." },
        { status: 400 },
      ),
    );
  }

  try {
    const events = await listRecentEvents(limit);

    return withCors(
      NextResponse.json(
        { events },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      ),
    );
  } catch (error) {
    console.error("Failed to load recent events", error);

    return withCors(
      NextResponse.json(
        { ok: false, error: "Failed to load recent events." },
        { status: 500 },
      ),
    );
  }
}
