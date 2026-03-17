import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.mjs";

type RuntimeServer = ReturnType<typeof createGatewayRuntimeServer>;

export function createRuntimeTestHarness() {
  const runtimeServers: RuntimeServer[] = [];
  const metadataServers: http.Server[] = [];
  const runtimeTempDirs: string[] = [];

  async function createTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-runtime-"));
    runtimeTempDirs.push(tempDir);
    return tempDir;
  }

  async function createIsolatedRuntimeServer({
    apiBaseUrl,
    runtimeHost,
    runtimePort,
    onControlCommand,
  }: {
    apiBaseUrl: string;
    runtimeHost: string;
    runtimePort: number;
    onControlCommand?: ((command: unknown) => unknown | Promise<unknown>) | null;
  }) {
    const tempDir = await createTempDir();
    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl,
      runtimeHost,
      runtimePort,
      knownNodesPath: path.join(tempDir, "gateway-known-nodes.json"),
      onControlCommand: onControlCommand ?? null,
    });
    runtimeServers.push(runtimeServer);
    return runtimeServer;
  }

  function trackRuntimeServer(runtimeServer: RuntimeServer) {
    runtimeServers.push(runtimeServer);
    return runtimeServer;
  }

  async function startMetadataServer(
    handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  ) {
    const metadataServer = http.createServer(handler);
    metadataServers.push(metadataServer);
    const metadataPort = 47110 + Math.floor(Math.random() * 1000);
    await new Promise<void>((resolve, reject) => {
      metadataServer.listen(metadataPort, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return metadataPort;
  }

  async function cleanup() {
    while (runtimeServers.length > 0) {
      const server = runtimeServers.pop();
      await server?.stop();
    }

    while (metadataServers.length > 0) {
      const server = metadataServers.pop();
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    while (runtimeTempDirs.length > 0) {
      const tempDir = runtimeTempDirs.pop();
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  return {
    cleanup,
    createIsolatedRuntimeServer,
    createTempDir,
    startMetadataServer,
    trackRuntimeServer,
  };
}
