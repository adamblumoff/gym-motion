import { NextResponse } from "next/server";

import { listRecentEvents } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    const events = await listRecentEvents();

    return NextResponse.json(
      { events },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Failed to load events", error);

    return NextResponse.json(
      { ok: false, error: "Failed to load events." },
      { status: 500 },
    );
  }
}
