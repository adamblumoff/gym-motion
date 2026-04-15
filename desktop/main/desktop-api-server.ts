import http from "node:http";

import type { DeviceLogSummary, MotionStreamPayload } from "@core/contracts";

import { notFound, json } from "./desktop-api/http";
import { handleDeviceRoutes } from "./desktop-api/routes/devices";
import { handleEventRoutes } from "./desktop-api/routes/events";
import { handleFirmwareRoutes } from "./desktop-api/routes/firmware";

export type DesktopDataEvent =
  | {
      type: "motion-update";
      payload: MotionStreamPayload;
      sourceMessageId?: string;
    }
  | {
      type: "device-log";
      payload: DeviceLogSummary;
      sourceMessageId?: string;
    }
  | {
      type: "device-updated";
      payload: unknown;
    };

type ServerHandle = {
  apiBaseUrl: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onEvent: (listener: (event: DesktopDataEvent) => void) => () => void;
};

export function createDesktopApiServer(): ServerHandle {
  const listeners = new Set<(event: DesktopDataEvent) => void>();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error("[desktop-api] request failed", error);
      json(response, 500, { ok: false, error: "Desktop API failed." });
    });
  });
  let apiBaseUrl = "http://127.0.0.1:0";

  function emit(event: DesktopDataEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const url = new URL(request.url ?? "/", apiBaseUrl);
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
        emit: (event) => emit(event as DesktopDataEvent),
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
        emit: (event) => emit(event as DesktopDataEvent),
      })
    ) {
      return;
    }

    notFound(response);
  }

  return {
    get apiBaseUrl() {
      return apiBaseUrl;
    },
    async start() {
      if (server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });

      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Desktop API failed to bind to a local port.");
      }

      apiBaseUrl = `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      if (!server.listening) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
