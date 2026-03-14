import { NextResponse } from "next/server";

import { getGatewayRuntimeDevices } from "@/lib/gateway-runtime-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getGatewayRuntimeDevices();

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
