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

  it("keeps telemetry from changing transport connection state", async () => {
    const runtimePort = 46110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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

  it("marks devices unreachable when the adapter goes offline", async () => {
    const runtimePort = 49110 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
    const reconnectingDevice = reconnectPayload.devices.find(
      (item: { id: string }) => item.id === "stack-001",
    );

    expect(reconnectingDevice?.gatewayConnectionState).toBe("reconnecting");
    expect(reconnectingDevice?.reconnectAttempt).toBe(1);
    expect(reconnectPayload.gateway?.reconnectingNodeCount).toBe(1);
  });

  it("keeps approved nodes disconnected during silent reconnect scanning until connect starts", async () => {
    const runtimePort = 50210 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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

  it("reports manual scan reason separately from silent reconnect search", async () => {
    const runtimePort = 50410 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
    const runtimeServer = await harness.createIsolatedRuntimeServer({
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
});
