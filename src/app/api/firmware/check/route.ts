import { NextResponse } from "next/server";

import { checkForFirmwareUpdate } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");
  const firmwareVersion = searchParams.get("firmwareVersion");

  if (!deviceId) {
    return NextResponse.json(
      { ok: false, error: "deviceId is required." },
      { status: 400 },
    );
  }

  try {
    const result = await checkForFirmwareUpdate({
      deviceId,
      firmwareVersion,
    });

    return NextResponse.json(
      {
        ok: true,
        updateAvailable: result.updateAvailable,
        device: result.device,
        release: result.release,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Failed to check firmware updates", error);

    return NextResponse.json(
      { ok: false, error: "Failed to check firmware updates." },
      { status: 500 },
    );
  }
}
