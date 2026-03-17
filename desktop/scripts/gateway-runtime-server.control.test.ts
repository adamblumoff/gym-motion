import { afterEach, describe, expect, it } from "bun:test";

import { createRuntimeTestHarness } from "./gateway-runtime-server.test-helpers";

const harness = createRuntimeTestHarness();

afterEach(async () => {
  await harness.cleanup();
});

describe("gateway runtime server control and manual scan routes", () => {
  it("exposes manual scan candidates and pairing state separately from gateway devices", async () => {
    const runtimePort = 50410 + Math.floor(Math.random() * 1000);
    const runtimeServer = await harness.createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
    });

    await runtimeServer.start();
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

    const response = await fetch(`http://127.0.0.1:${runtimePort}/manual-scan`);
    const payload = await response.json();

    expect(payload.state).toBe("pairing");
    expect(payload.pairingCandidateId).toBe("peripheral:pair-me");
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]?.id).toBe("peripheral:pair-me");
  });

  it("accepts control commands over HTTP", async () => {
    const runtimePort = 50435 + Math.floor(Math.random() * 1000);
    const receivedCommands: unknown[] = [];
    const runtimeServer = await harness.createIsolatedRuntimeServer({
      apiBaseUrl: "http://127.0.0.1:9",
      runtimeHost: "127.0.0.1",
      runtimePort,
      onControlCommand: async (command) => {
        receivedCommands.push(command);
        return { echoedType: (command as { type?: string })?.type ?? null };
      },
    });

    await runtimeServer.start();

    const response = await fetch(`http://127.0.0.1:${runtimePort}/control`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "start_manual_scan" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.echoedType).toBe("start_manual_scan");
    expect(receivedCommands).toEqual([{ type: "start_manual_scan" }]);
  });
});
