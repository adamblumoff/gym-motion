import http from "node:http";

import { afterEach, describe, expect, it } from "bun:test";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.mjs";

const runtimeServers: Array<ReturnType<typeof createGatewayRuntimeServer>> = [];
const metadataServers: http.Server[] = [];

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
});

describe("gateway runtime server", () => {
  it("accepts explicit known device ids on transport events", async () => {
    const runtimePort = 46110 + Math.floor(Math.random() * 1000);
    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });
    runtimeServers.push(runtimeServer);

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
    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });
    runtimeServers.push(runtimeServer);

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
    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: `http://127.0.0.1:${metadataPort}`,
      runtimeHost: "127.0.0.1",
      runtimePort,
    });
    runtimeServers.push(runtimeServer);

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
    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });
    runtimeServers.push(runtimeServer);

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

  it("marks rediscovered known nodes as reconnecting while scanning", async () => {
    const runtimePort = 50110 + Math.floor(Math.random() * 1000);
    const runtimeServer = createGatewayRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });
    runtimeServers.push(runtimeServer);

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

    expect(device?.gatewayConnectionState).toBe("reconnecting");
    expect(payload.gateway?.reconnectingNodeCount).toBe(1);
  });
});
