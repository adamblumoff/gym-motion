import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The runtime server is still authored as an ESM .mjs module.
// @ts-expect-error local .mjs runtime modules do not publish TypeScript declarations yet
import { createGatewayRuntimeServer } from "./gateway-runtime-server.mjs";

type RuntimeServer = ReturnType<typeof createGatewayRuntimeServer>;

const runtimeServers: RuntimeServer[] = [];
const tempDirs: string[] = [];

async function createRuntimeServer(options: {
  apiBaseUrl?: string;
  runtimeHost?: string;
  runtimePort: number;
  onControlCommand?: ((command: unknown) => unknown | Promise<unknown>) | null;
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-runtime-test-"));
  tempDirs.push(tempDir);
  const runtimeServer = createGatewayRuntimeServer({
    apiBaseUrl: options.apiBaseUrl ?? "http://127.0.0.1:9",
    runtimeHost: options.runtimeHost ?? "127.0.0.1",
    runtimePort: options.runtimePort,
    knownNodesPath: path.join(tempDir, "gateway-known-nodes.json"),
    onControlCommand: options.onControlCommand ?? null,
  });
  runtimeServers.push(runtimeServer);
  return runtimeServer;
}

afterEach(async () => {
  while (runtimeServers.length > 0) {
    const runtimeServer = runtimeServers.pop();
    await runtimeServer?.stop();
  }

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

describe("gateway runtime server", () => {
  it("exposes health, manual scan, and control routes directly from the backend runtime", async () => {
    const runtimePort = 51100 + Math.floor(Math.random() * 1000);
    const receivedCommands: unknown[] = [];
    const runtimeServer = await createRuntimeServer({
      runtimePort,
      onControlCommand: async (command) => {
        receivedCommands.push(command);
        return { echoedType: (command as { type?: string })?.type ?? null };
      },
    });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.setManualScanState({
      state: "pairing",
      pairingCandidateId: "peripheral:pair-me",
      error: null,
      clearCandidates: true,
    });
    runtimeServer.upsertManualScanCandidate({
      id: "peripheral:pair-me",
      label: "GymMotion-f4e9d4",
      peripheralId: "pair-me",
      address: "AA:BB:CC:DD",
      localName: "GymMotion-f4e9d4",
      knownDeviceId: null,
      machineLabel: null,
      siteId: null,
      lastRssi: -58,
      lastSeenAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
    });

    const healthResponse = await fetch(`http://127.0.0.1:${runtimePort}/health`);
    const manualScanResponse = await fetch(`http://127.0.0.1:${runtimePort}/manual-scan`);
    const controlResponse = await fetch(`http://127.0.0.1:${runtimePort}/control`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "start_manual_scan" }),
    });

    expect(await healthResponse.json()).toMatchObject({
      ok: true,
      gateway: {
        adapterState: "poweredOn",
      },
    });
    expect(await manualScanResponse.json()).toMatchObject({
      state: "pairing",
      pairingCandidateId: "peripheral:pair-me",
      candidates: [
        expect.objectContaining({
          id: "peripheral:pair-me",
        }),
      ],
    });
    expect(await controlResponse.json()).toEqual({
      ok: true,
      echoedType: "start_manual_scan",
    });
    expect(receivedCommands).toEqual([{ type: "start_manual_scan" }]);
  });

  it("keeps transport state separate from telemetry freshness in projected device snapshots", async () => {
    const runtimePort = 51200 + Math.floor(Math.random() * 1000);
    const runtimeServer = await createRuntimeServer({ runtimePort });

    await runtimeServer.start();
    runtimeServer.setAdapterState("poweredOn");
    runtimeServer.noteConnected({
      deviceId: "stack-001",
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB",
      localName: "GymMotion-f4e9d4",
      rssi: -52,
    });
    runtimeServer.noteDisconnected({
      deviceId: "stack-001",
      knownDeviceId: "stack-001",
      peripheralId: "peripheral-1",
      address: "AA:BB",
      localName: "GymMotion-f4e9d4",
      reason: "ble-disconnected",
    });
    await runtimeServer.noteTelemetry(
      {
        deviceId: "stack-001",
        state: "moving",
        timestamp: 123,
        delta: 7,
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
      {
        peripheralId: "peripheral-1",
        address: "AA:BB",
        localName: "GymMotion-f4e9d4",
        rssi: -48,
      },
    );

    const devicesResponse = await fetch(`http://127.0.0.1:${runtimePort}/devices`);
    const payload = await devicesResponse.json();

    expect(payload.devices).toEqual([
      expect.objectContaining({
        id: "stack-001",
        gatewayConnectionState: "disconnected",
        lastState: "moving",
        telemetryFreshness: "fresh",
      }),
    ]);
  });
});
