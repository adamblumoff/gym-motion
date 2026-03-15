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
});
