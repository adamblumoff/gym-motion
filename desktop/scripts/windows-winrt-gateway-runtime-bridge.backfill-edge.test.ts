import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeServer,
  flushBackgroundWork,
} from "./windows-winrt-gateway-runtime-bridge.test-support";
import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge";

afterEach(() => {
  vi.useRealTimers();
});

describe("windows winrt gateway runtime bridge backfill edge cases", () => {
  it("pauses backfill after persistence failure without acking", async () => {
    const sidecarCommands = [];
    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
        historySyncStabilityWindowMs: 0,
        historySyncInterPageDelayMs: 0,
      },
      runtimeServer: createRuntimeServer(),
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl(url) {
        if (String(url).includes("/api/device-sync/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              syncState: { deviceId: "stack-001", lastAckedSequence: 0, lastAckedBootId: null },
              historySyncState: {
                deviceId: "stack-001",
                lastAckedHistorySequence: 0,
                lastHistorySyncCompletedAt: null,
                lastHistoryOverflowDetectedAt: null,
              },
            }),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 500,
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await flushBackgroundWork();

    const requestId = sidecarCommands[0]?.request_id;
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: { kind: "motion", sequence: 1, state: "moving", delta: 8, timestamp: 1 },
    });
    await bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        request_id: requestId,
        latest_sequence: 1,
        high_water_sequence: 1,
        sent_count: 1,
        has_more: false,
        overflowed: false,
      },
    });

    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 0,
        max_records: 256,
        request_id: expect.any(String),
      }),
    ]);
  });

  it("drops an in-flight buffered page on disconnect and resumes from stored ack on reconnect", async () => {
    const sidecarCommands = [];
    const fetchCalls = [];
    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
        historySyncStabilityWindowMs: 0,
        historySyncInterPageDelayMs: 0,
      },
      runtimeServer: createRuntimeServer({
        resolveKnownDeviceId() {
          return "stack-001";
        },
      }),
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl(url) {
        fetchCalls.push(String(url));
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: { deviceId: "stack-001", lastAckedSequence: 6, lastAckedBootId: "boot-1" },
            historySyncState: {
              deviceId: "stack-001",
              lastAckedHistorySequence: 6,
              lastHistorySyncCompletedAt: null,
              lastHistoryOverflowDetectedAt: null,
            },
          }),
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 7,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await flushBackgroundWork();

    const firstRequestId = sidecarCommands[0]?.request_id;
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: firstRequestId,
      record: { kind: "motion", sequence: 7, state: "moving", delta: 8, timestamp: 1 },
    });
    bridge.handleNodeConnectionState({
      gatewayConnectionState: "disconnected",
      reason: "ble-disconnected",
      node: { peripheralId: "AA:BB", knownDeviceId: "stack-001" },
    });
    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "still",
      timestamp: 2,
      delta: 0,
      sequence: 8,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await flushBackgroundWork();

    expect(fetchCalls).toEqual([
      "http://127.0.0.1:4111/api/device-sync/stack-001?bootId=boot-1",
      "http://127.0.0.1:4111/api/device-sync/stack-001?bootId=boot-1",
    ]);
    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 6,
        max_records: 256,
        request_id: expect.any(String),
      }),
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 6,
        max_records: 256,
        request_id: expect.any(String),
      }),
    ]);
  });
});
