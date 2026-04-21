import http from "node:http";

import dotenv from "dotenv";

import { createApiEventStream } from "./event-stream";
import { json } from "./http";
import { createBackendApiHandler } from "./handler";

dotenv.config({ path: ".env.local" });
dotenv.config();

function readPort() {
  const value = Number(process.env.PORT ?? "3000");
  return Number.isFinite(value) && value > 0 ? value : 3000;
}

async function main() {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = readPort();
  const eventStream = createApiEventStream();
  const handleRequest = createBackendApiHandler({
    emit: eventStream.emit,
    getBaseUrl: (request) => `http://${request.headers.host ?? `${host}:${port}`}`,
    handleSse: eventStream.handleSse,
  });

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error("[backend-api] request failed", error);
      json(response, 500, { ok: false, error: "Backend API failed." });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`[backend-api] listening on http://${host}:${port}`);

  const shutdown = async (signal: string) => {
    console.log(`[backend-api] received ${signal}, shutting down`);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error("[backend-api] failed to start", error);
  process.exit(1);
});
