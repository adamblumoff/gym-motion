import {
  subscribeToDeviceLogs,
  subscribeToMotionUpdates,
} from "@/lib/motion-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function formatEvent(event: string, payload: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: Request) {
  let cleanupMotion = () => {};
  let cleanupLogs = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const sendPing = () => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      };

      controller.enqueue(formatEvent("connected", { ok: true }));

      cleanupMotion = subscribeToMotionUpdates((payload) => {
        controller.enqueue(formatEvent("motion-update", payload));
      });
      cleanupLogs = subscribeToDeviceLogs((payload) => {
        controller.enqueue(formatEvent("device-log", payload));
      });

      const pingInterval = setInterval(sendPing, 15000);

      const close = () => {
        clearInterval(pingInterval);
        cleanupMotion();
        cleanupLogs();
        try {
          controller.close();
        } catch {}
      };

      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanupMotion();
      cleanupLogs();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}
