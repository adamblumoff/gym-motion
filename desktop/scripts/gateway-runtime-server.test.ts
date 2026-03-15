import { afterEach, describe, expect, it } from "bun:test";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.mjs";

const runtimeServers: Array<ReturnType<typeof createGatewayRuntimeServer>> = [];

afterEach(async () => {
  while (runtimeServers.length > 0) {
    const server = runtimeServers.pop();
    await server?.stop();
  }
});

describe("gateway runtime server", () => {
  it("ignores transient disconnects immediately after telemetry", async () => {
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

    await runtimeServer.noteTelemetry(
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

    const applied = runtimeServer.noteDisconnected({
      peripheralId: "peripheral-1",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      reason: "Device disconnected.",
    });

    const response = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await response.json();
    const device = payload.devices.find((item: { id: string }) => item.id === "stack-001");

    expect(applied).toBe(false);
    expect(device?.gatewayConnectionState).toBe("connected");
  });
});
