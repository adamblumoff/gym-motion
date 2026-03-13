import { NextResponse } from "next/server";

import { getDeviceSyncState } from "@/lib/repository";

export const runtime = "nodejs";

type DeviceSyncRouteProps = {
  params: Promise<{
    deviceId: string;
  }>;
};

export async function GET(
  _request: Request,
  context: DeviceSyncRouteProps,
) {
  const { deviceId } = await context.params;

  if (!deviceId) {
    return NextResponse.json(
      { ok: false, error: "deviceId is required." },
      { status: 400 },
    );
  }

  try {
    const syncState = await getDeviceSyncState(deviceId);
    return NextResponse.json({ ok: true, syncState });
  } catch (error) {
    console.error("Failed to load device sync state", error);

    return NextResponse.json(
      { ok: false, error: "Failed to load device sync state." },
      { status: 500 },
    );
  }
}
