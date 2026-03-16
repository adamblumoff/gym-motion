import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.mjs";

const runtimeServers: Array<ReturnType<typeof createGatewayRuntimeServer>> = [];
const metadataServers: http.Server[] = [];
const runtimeTempDirs: string[] = [];

async function createIsolatedRuntimeServer({
  apiBaseUrl,
  runtimeHost,
  runtimePort,
}: {
  apiBaseUrl: string;
  runtimeHost: string;
  runtimePort: number;
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-runtime-"));
  runtimeTempDirs.push(tempDir);
  const runtimeServer = createGatewayRuntimeServer({
    apiBaseUrl,
    runtimeHost,
    runtimePort,
    knownNodesPath: path.join(tempDir, "gateway-known-nodes.json"),
  });
  runtimeServers.push(runtimeServer);
  return runtimeServer;
}

afterEach(async () => {
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
});

describe("gateway runtime server", () => {
  it("accepts explicit known device ids on transport events", async () => {
    const runtimePort = 46110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("scanning");

    runtimeServer.noteDiscovery({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("connected");
  });

  it("keeps telemetry from changing transport connection state", async () => {
    const runtimePort = 46110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("stopped");
    runtimeServer.noteDisconnected({
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      reason: "Initial state.",
    });

    const telemetryResult = await runtimeServer.noteTelemetry(
      {
        deviceId: "stack-001",
        state: "moving",
        timestamp: Date.now(),
        delta: 12,
        sequence: 1,
        bootId: "boot-1",
        firmwareVersion: "0.5.1",
        hardwareId: "hw-1",
      },
      {
        peripheralId: "peripheral-1",
        address: "AA:BB:CC:DD",
        localName: "GymMotion-f4e9d4",
        rssi: -58,
      },
    );

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(telemetryResult?.before?.gatewayConnectionState).toBe("unreachable");
    expect(device?.gatewayConnectionState).toBe("discovered");
    expect(device?.telemetryFreshness).toBe("fresh");
  });

  it("treats recent heartbeats as fresh when telemetry is idle", async () => {
    const metadataPort = 47110 + Math.floor(Math.random() * 1000);
    const metadataServer = http.createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          devices: [
            {
              id: "stack-001",
              lastState: "still",
              lastSeenAt: Date.now(),
              lastDelta: null,
              updatedAt: new Date().toISOString(),
              hardwareId: "hw-1",
              bootId: "boot-1",
              firmwareVersion: "0.5.1",
              machineLabel: "Leg Press",
              siteId: "Dallas",
              provisioningState: "provisioned",
              updateStatus: "idle",
              updateTargetVersion: null,
              updateDetail: null,
              updateUpdatedAt: null,
              lastHeartbeatAt: new Date().toISOString(),
              lastEventReceivedAt: new Date().toISOString(),
              healthStatus: "online",
            },
          ],
        }),
      );
    });
    metadataServers.push(metadataServer);
    await new Promise<void>((resolve, reject) => {
      metadataServer.listen(metadataPort, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    const runtimePort = 48110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: `http://127.0.0.1:${metadataPort}`,
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("stopped");
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("connected");
    expect(device?.telemetryFreshness).toBe("fresh");
    expect(device?.healthStatus).toBe("online");
  });

  it("marks devices unreachable when the adapter goes offline", async () => {
    const runtimePort = 49110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("stopped");
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });
    runtimeServer.setAdapterState("poweredOff");

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("unreachable");
    expect(device?.gatewayDisconnectReason).toBe("adapter-poweredOff");
  });

  it("marks approved reconnect attempts as reconnecting only after connect starts", async () => {
    const runtimePort = 50110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("stopped");
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });
    runtimeServer.noteDisconnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      reason: "link lost",
    });
    runtimeServer.setScanState("scanning");
    runtimeServer.noteDiscovery({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("disconnected");

    runtimeServer.noteConnecting({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
      reconnectAttempt: 1,
      reconnectAttemptLimit: 20,
    });

    const reconnectResponse = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const reconnectPayload = await reconnectResponse.json();
    const reconnectingDevice = reconnectPayload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(reconnectingDevice?.gatewayConnectionState).toBe("reconnecting");
    expect(reconnectingDevice?.reconnectAttempt).toBe(1);
    expect(reconnectPayload.gateway?.reconnectingNodeCount).toBe(1);
  });

  it("keeps approved nodes disconnected during silent reconnect scanning until connect starts", async () => {
    const runtimePort = 50210 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("stopped");
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });
    runtimeServer.noteDisconnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      reason: "link lost",
    });
    runtimeServer.setScanState("scanning", "approved-reconnect");

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("disconnected");
    expect(payload.gateway?.reconnectingNodeCount).toBe(0);
  });

  it("keeps cached approved nodes disconnected while startup scan is still silent", async () => {
    const runtimePort = 50310 + Math.floor(Math.random() * 1000);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-runtime-"));
    runtimeTempDirs.push(tempDir);
    const knownNodesPath = path.join(tempDir, "gateway-known-nodes.json");
    await fs.writeFile(
      knownNodesPath,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        nodes: [
          {
            deviceId: "stack-001",
            peripheralId: "peripheral-1",
            lastAdvertisedName: "GymMotion-f4e9d4",
            lastKnownAddress: "AA:BB:CC:DD",
            lastSeenAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          },
        ],
      }),
      "utf8",
    );

    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
      knownNodesPath,
    });
    runtimeServers.push(runtimeServer);

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("scanning");

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("disconnected");
    expect(payload.gateway?.reconnectingNodeCount).toBe(0);
  });

  it("resolves address-only known nodes case-insensitively during rediscovery", async () => {
    const runtimePort = 50360 + Math.floor(Math.random() * 1000);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-runtime-"));
    runtimeTempDirs.push(tempDir);
    const knownNodesPath = path.join(tempDir, "gateway-known-nodes.json");
    await fs.writeFile(
      knownNodesPath,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        nodes: [
          {
            deviceId: "stack-001",
            peripheralId: null,
            lastAdvertisedName: null,
            lastKnownAddress: "AA:BB:CC:DD",
            lastSeenAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          },
        ],
      }),
      "utf8",
    );

    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
      knownNodesPath,
    });
    runtimeServers.push(runtimeServer);

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("scanning");
    runtimeServer.noteDiscovery({
      knownDeviceId: null,
      peripheralId: "peripheral-1",
      address: "aa:bb:cc:dd",
      localName: null,
      rssi: -58,
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.id).toBe("stack-001");
    expect(payload.devices.map((item: { id: string }) => item.id)).toEqual(["stack-001"]);
    expect(device?.gatewayConnectionState).toBe("disconnected");
    expect(device?.address).toBe("aa:bb:cc:dd");
  });

  it("reports manual scan reason separately from silent reconnect search", async () => {
    const runtimePort = 50410 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("scanning", "manual");

    const response = await fetch(`http://127.0.0.1:${runtimePort}/health`);
    const payload = await response.json();

    expect(payload.gateway?.scanState).toBe("scanning");
    expect(payload.gateway?.scanReason).toBe("manual");
  });

  it("defaults reconnectAttempt when connecting metadata omits it", async () => {
    const runtimePort = 50460 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("scanning");
    runtimeServer.noteConnecting({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("reconnecting");
    expect(device?.reconnectAttempt).toBe(0);
  });

  it("marks disconnects as disconnected immediately even while scanning", async () => {
    const runtimePort = 50610 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("scanning");
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });
    runtimeServer.noteDisconnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      reason: "link lost",
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("disconnected");
    expect(device?.gatewayDisconnectReason).toBe("link lost");
  });

  it("exposes reconnect exhaustion metadata on disconnected devices", async () => {
    const runtimePort = 50710 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.noteDisconnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      reason: "retry limit reached",
      reconnectAttempt: 20,
      reconnectAttemptLimit: 20,
      reconnectRetryExhausted: true,
      reconnectAwaitingDecision: true,
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("disconnected");
    expect(device?.reconnectAttempt).toBe(20);
    expect(device?.reconnectAttemptLimit).toBe(20);
    expect(device?.reconnectRetryExhausted).toBe(true);
    expect(device?.reconnectAwaitingDecision).toBe(true);
  });

  it("emits discovered instead of unreachable on first discovery for a known node", async () => {
    const runtimePort = 51110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setScanState("stopped");
    runtimeServer.noteDiscovery({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("discovered");
  });

  it("flushes pending known-node cache writes on stop", async () => {
    const runtimePort = 52110 + Math.floor(Math.random() * 1000);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-runtime-"));
    runtimeTempDirs.push(tempDir);
    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
      knownNodesPath: path.join(tempDir, "gateway-known-nodes.json"),
    });
    runtimeServers.push(runtimeServer);

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.noteDiscovery({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });
    await runtimeServer.stop();

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDir, "gateway-known-nodes.json"), "utf8"),
    );

    expect(Array.isArray(persisted.nodes)).toBe(true);
    expect(
      persisted.nodes.some(
        (node: { deviceId?: string; peripheralId?: string }) =>
          node.deviceId === "stack-001" && node.peripheralId === "peripheral-1",
      ),
    ).toBe(true);
  });
});
