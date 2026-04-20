import http from "node:http";

import type { DeviceLogSummary, MotionStreamPayload } from "@core/contracts";

import { createBackendApiHandler } from "../../backend/server/handler";
import { json } from "../../backend/server/http";

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
  let apiBaseUrl = "http://127.0.0.1:0";
  const handleRequest = createBackendApiHandler({
    emit: (event) => emit(event as DesktopDataEvent),
    getBaseUrl: () => apiBaseUrl,
  });
  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error("[desktop-api] request failed", error);
      json(response, 500, { ok: false, error: "Desktop API failed." });
    });
  });

  function emit(event: DesktopDataEvent) {
    for (const listener of listeners) {
      listener(event);
    }
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
