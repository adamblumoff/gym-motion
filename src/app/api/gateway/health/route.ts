import { NextResponse } from "next/server";

import { getGatewayRuntimeHealth } from "@/lib/gateway-runtime-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getGatewayRuntimeHealth();

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
