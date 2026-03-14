import { NextResponse } from "next/server";

import {
  formatZodError,
  parseFirmwareRelease,
} from "@/lib/motion";
import {
  createFirmwareRelease,
  listFirmwareReleases,
} from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    const releases = await listFirmwareReleases();

    return NextResponse.json(
      { releases },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Failed to load firmware releases", error);

    return NextResponse.json(
      { ok: false, error: "Failed to load firmware releases." },
      { status: 500 },
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

  const parsedPayload = parseFirmwareRelease(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { ok: false, error: formatZodError(parsedPayload.error) },
      { status: 400 },
    );
  }

  try {
    const release = await createFirmwareRelease(parsedPayload.data);

    return NextResponse.json({ ok: true, release });
  } catch (error) {
    console.error("Failed to save firmware release", error);

    return NextResponse.json(
      { ok: false, error: "Failed to save firmware release." },
      { status: 500 },
    );
  }
}
