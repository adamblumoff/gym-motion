import { afterEach, describe, expect, it } from "bun:test";

import { createRuntimeTestHarness } from "./gateway-runtime-server.test-helpers";

const harness = createRuntimeTestHarness();

afterEach(async () => {
  await harness.cleanup();
});

describe("gateway runtime server transport state", () => {
  it("accepts explicit known device ids on transport events", async () => {
    const runtimePort = 46110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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

  it("treats recent heartbeats as fresh when telemetry is idle", async () => {
    const metadataPort = await harness.startMetadataServer((_request, response) => {
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

    const runtimePort = 48110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
});
