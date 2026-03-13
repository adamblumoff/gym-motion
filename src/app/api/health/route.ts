import os from "node:os";

import { NextResponse } from "next/server";

import { withCors, createCorsPreflightResponse } from "@/lib/api-cors";

export const runtime = "nodejs";

export function OPTIONS() {
  return createCorsPreflightResponse();
}

export async function GET() {
  return withCors(
    NextResponse.json({
      ok: true,
      gateway: {
        hostname: os.hostname(),
        mode: "reference-ble-node-gateway",
      },
    }),
  );
}
