import { NextResponse } from "next/server";

import { formatZodError, parseIngestPayload } from "@/lib/motion";
import { recordMotionEvent } from "@/lib/repository";

export const runtime = "nodejs";

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

  const parsedPayload = parseIngestPayload(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { ok: false, error: formatZodError(parsedPayload.error) },
      { status: 400 },
    );
  }

  try {
    await recordMotionEvent(parsedPayload.data);
  } catch (error) {
    console.error("Failed to ingest motion event", error);

    return NextResponse.json(
      { ok: false, error: "Failed to store motion event." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
