import { proxyGatewayRuntimeStream } from "@/lib/gateway-runtime-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function createUnavailableStream(message: string) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: gateway-status\ndata: ${JSON.stringify({
            ok: false,
            gateway: {
              hostname: "unavailable",
              mode: "reference-ble-node-gateway",
              sessionId: "unavailable",
              adapterState: "unavailable",
              scanState: "stopped",
              connectedNodeCount: 0,
              reconnectingNodeCount: 0,
              knownNodeCount: 0,
              startedAt: new Date(0).toISOString(),
              updatedAt: new Date().toISOString(),
              lastAdvertisementAt: null,
            },
            error: message,
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 503,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}

export async function GET() {
  try {
    const upstream = await proxyGatewayRuntimeStream();

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
    });
  } catch (error) {
    return createUnavailableStream(
      error instanceof Error ? error.message : "Gateway runtime stream unavailable.",
    );
  }
}
