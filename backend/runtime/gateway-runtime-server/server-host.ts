import http from "node:http";

import { jsonResponse } from "./utils.js";

export function createGatewayServerHost({
  runtimeHost,
  runtimePort,
  handleRequest,
  debug,
}: {
  runtimeHost: string;
  runtimePort: number;
  handleRequest: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  debug: (message: string, details?: unknown) => void;
}) {
  let server: http.Server | null = null;

  return {
    async start() {
      if (server) {
        return;
      }

      server = http.createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          console.error("[gateway-runtime] request failed", error);
          jsonResponse(response, 500, { ok: false, error: "Gateway runtime failed." });
        });
      });

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(runtimePort, runtimeHost, () => {
          server?.off("error", reject);
          resolve();
        });
      });

      debug(`runtime API listening on http://${runtimeHost}:${runtimePort}`);
    },

    async stop() {
      if (!server) {
        return;
      }

      const currentServer = server;
      server = null;

      await new Promise<void>((resolve, reject) => {
        currentServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}
