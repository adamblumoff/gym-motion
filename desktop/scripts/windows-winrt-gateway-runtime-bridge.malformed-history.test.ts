import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeServer,
  flushBackgroundWork,
} from "./windows-winrt-gateway-runtime-bridge.test-support";
vi.mock("./windows-winrt-gateway-desktop-ipc.js", () => ({
  sendToDesktop: () => true,
}));
import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge";

afterEach(() => {
  vi.useRealTimers();
});

describe("windows winrt gateway runtime bridge malformed history recovery", () => {
  it("persists recovered extra history records when a malformed payload yields more records than sent_count", async () => {
    const sidecarCommands = [];
    const persistedBodies = [];

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
      fetchImpl(url, init) {
        if (String(url).includes("/api/device-sync/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              syncState: { deviceId: "stack-001", lastAckedSequence: 782, lastAckedBootId: "boot-1" },
              historySyncState: {
                deviceId: "stack-001",
                lastAckedHistorySequence: 782,
                lastHistorySyncCompletedAt: null,
                lastHistoryOverflowDetectedAt: null,
              },
            }),
          });
        }

        persistedBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: { deviceId: "stack-001", lastAckedSequence: 782, lastAckedBootId: "boot-1" },
            historySyncState: {
              deviceId: "stack-001",
              lastAckedHistorySequence: 1586,
              lastHistorySyncCompletedAt: "2026-03-20T00:00:00.000Z",
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
      sequence: 783,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await flushBackgroundWork();
    const requestId = sidecarCommands[0]?.request_id;

    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: {
        kind: "node-log",
        sequence: 783,
        level: "info",
        code: "runtime.app_session.online",
        message: "online",
        timestamp: 1,
        bootId: "boot-a",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    });
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: {
        kind: "node-log",
        sequence: 1451,
        level: "info",
        code: "runtime.app_session.online",
        message: "online",
        timestamp: 2,
        bootId: "boot-b",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    });
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: {
        kind: "motion",
        sequence: 1585,
        state: "still",
        delta: 70,
        timestamp: 3,
        bootId: "boot-c",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    });
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: {
        kind: "node-log",
        sequence: 1586,
        level: "warn",
        code: "runtime.app_session.offline",
        message: "offline",
        timestamp: 4,
        bootId: "boot-c",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    });

    await bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        request_id: requestId,
        latest_sequence: 1586,
        high_water_sequence: 2289,
        sent_count: 3,
        has_more: false,
        overflowed: false,
      },
    });

    expect(persistedBodies).toHaveLength(1);
    expect(persistedBodies[0].records).toHaveLength(4);
    expect(persistedBodies[0].ackSequence).toBe(1586);
    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 782,
        max_records: 256,
        request_id: expect.any(String),
      }),
      expect.objectContaining({
        type: "acknowledge_history_sync",
        device_id: "stack-001",
        sequence: 1586,
        request_id: requestId,
      }),
    ]);
  });
});
