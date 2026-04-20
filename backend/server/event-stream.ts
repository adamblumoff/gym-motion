import type http from "node:http";

type ApiEvent = unknown;
type EventListener = (event: ApiEvent) => void;

export function createApiEventStream() {
  const listeners = new Set<EventListener>();

  function emit(event: ApiEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function subscribe(listener: EventListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function handleSse(request: http.IncomingMessage, response: http.ServerResponse) {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    });

    response.write(`event: ready\ndata: {"ok":true}\n\n`);

    const heartbeat = setInterval(() => {
      response.write(`: keep-alive\n\n`);
    }, 15_000);
    heartbeat.unref?.();

    const unsubscribe = subscribe((event) => {
      response.write(`event: invalidate\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    };

    request.on("close", close);
    request.on("error", close);
    response.on("close", close);
    response.on("error", close);
  }

  return {
    emit,
    handleSse,
  };
}
