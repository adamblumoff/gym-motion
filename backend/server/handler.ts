import type http from "node:http";

import { json, notFound } from "./http";
import { handleDeviceRoutes } from "./routes/devices";
import { handleEventRoutes } from "./routes/events";
import { handleFirmwareRoutes } from "./routes/firmware";

export function createBackendApiHandler({
  emit = () => {},
  getBaseUrl,
}: {
  emit?: (event: unknown) => void;
  getBaseUrl: (request: http.IncomingMessage) => string;
}) {
  return async function handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const url = new URL(request.url ?? "/", getBaseUrl(request));
    const pathname = url.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (
      await handleDeviceRoutes({
        request,
        response,
        pathname,
        method,
        url,
        emit,
      })
    ) {
      return;
    }

    if (await handleEventRoutes({ response, pathname, method, url })) {
      return;
    }

    if (
      await handleFirmwareRoutes({
        request,
        response,
        pathname,
        method,
        url,
        emit,
      })
    ) {
      return;
    }

    notFound(response);
  };
}
