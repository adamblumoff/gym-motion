import { NextResponse } from "next/server";

import { listDevices } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    const devices = await listDevices();

    return NextResponse.json(
      { devices },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Failed to load devices", error);

    return NextResponse.json(
      { ok: false, error: "Failed to load devices." },
      { status: 500 },
    );
  }
}
