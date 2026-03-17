import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.mjs";
import { createRuntimeTestHarness } from "./gateway-runtime-server.test-helpers";

const harness = createRuntimeTestHarness();

afterEach(async () => {
  await harness.cleanup();
});

describe("gateway runtime server known-node behavior", () => {
  it("keeps cached approved nodes disconnected while startup scan is still silent", async () => {
    const runtimePort = 50310 + Math.floor(Math.random() * 1000);
    const tempDir = await harness.createTempDir();
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

    const runtimeServer = harness.trackRuntimeServer(
      createGatewayRuntimeServer({
        apiBaseUrl: "http://127.0.0.1:9",
        runtimeHost: "127.0.0.1",
        runtimePort,
        knownNodesPath,
      }),
    );

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
    const tempDir = await harness.createTempDir();
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

    const runtimeServer = harness.trackRuntimeServer(
      createGatewayRuntimeServer({
        apiBaseUrl: "http://127.0.0.1:9",
        runtimeHost: "127.0.0.1",
        runtimePort,
        knownNodesPath,
      }),
    );

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

  it("flushes pending known-node cache writes on stop", async () => {
    const runtimePort = 52110 + Math.floor(Math.random() * 1000);
    const tempDir = await harness.createTempDir();
    const knownNodesPath = path.join(tempDir, "gateway-known-nodes.json");
    const runtimeServer = harness.trackRuntimeServer(
      createGatewayRuntimeServer({
        apiBaseUrl: "http://127.0.0.1:9",
        runtimeHost: "127.0.0.1",
        runtimePort,
        knownNodesPath,
      }),
    );

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

    const persisted = JSON.parse(await fs.readFile(knownNodesPath, "utf8"));

    expect(Array.isArray(persisted.nodes)).toBe(true);
    expect(
      persisted.nodes.some(
        (node: { deviceId?: string; peripheralId?: string }) =>
          node.deviceId === "stack-001" && node.peripheralId === "peripheral-1",
      ),
    ).toBe(true);
  });

  it("forgets devices by removing them from runtime payloads and known-node cache", async () => {
    const runtimePort = 53110 + Math.floor(Math.random() * 1000);
    const tempDir = await harness.createTempDir();
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
            lastSeenAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );

    const runtimeServer = harness.trackRuntimeServer(
      createGatewayRuntimeServer({
        apiBaseUrl: "http://127.0.0.1:9",
        runtimeHost: "127.0.0.1",
        runtimePort,
        knownNodesPath,
      }),
    );

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    runtimeServer.forgetDevice({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();

    expect(payload.devices).toEqual([]);

    await runtimeServer.stop();

    const persisted = JSON.parse(await fs.readFile(knownNodesPath, "utf8"));
    expect(persisted.nodes).toEqual([]);
  });

  it("does not let late transport events resurrect a forgotten device until it is approved again", async () => {
    const runtimePort = 54110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    runtimeServer.forgetDevice({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
    });
    runtimeServer.noteConnected({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      rssi: -58,
    });

    let response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    let payload = await response.json();
    expect(payload.devices).toEqual([]);

    runtimeServer.restoreApprovedDevice({
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
    });

    response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(device?.gatewayConnectionState).toBe("connected");
  });
});
