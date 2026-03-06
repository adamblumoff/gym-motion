import { NextResponse } from "next/server";

import { formatZodError, parseDeviceAssignment } from "@/lib/motion";
import { broadcastMotionUpdate } from "@/lib/motion-stream";
import { purgeDeviceData, updateDeviceAssignment } from "@/lib/repository";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const parsedPayload = parseDeviceAssignment(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { ok: false, error: formatZodError(parsedPayload.error) },
      { status: 400 },
    );
  }

  const { deviceId } = await context.params;

  try {
    const device = await updateDeviceAssignment(deviceId, parsedPayload.data);

    if (!device) {
      return NextResponse.json(
        { ok: false, error: "Device not found." },
        { status: 404 },
      );
    }

    broadcastMotionUpdate({ device });

    return NextResponse.json({ ok: true, device });
  } catch (error) {
    console.error("Failed to update device assignment", error);

    return NextResponse.json(
      { ok: false, error: "Failed to update device." },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { deviceId } = await context.params;

  try {
    const result = await purgeDeviceData(deviceId);

    if (result.deletedDevices === 0) {
      return NextResponse.json(
        { ok: false, error: "Device not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("Failed to delete device", error);

    return NextResponse.json(
      { ok: false, error: "Failed to delete device." },
      { status: 500 },
    );
  }
}
