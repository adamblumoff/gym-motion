import { describe, expect, it } from "vitest";

import {
  createRuntimeServer,
  flushBackgroundWork,
} from "./windows-winrt-gateway-runtime-bridge.test-support";
import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge";

describe("windows winrt gateway runtime bridge history errors", () => {
  it("pauses the active device backfill when the history channel reports an error", async () => {
    const sidecarCommands: Array<Record<string, unknown>> = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
        historySyncStabilityWindowMs: 0,
        historySyncInterPageDelayMs: 0,
        historySyncPageSize: 256,
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
              syncState: {
                deviceId: "stack-001",
                lastAckedSequence: 42,
                lastAckedBootId: "boot-1",
              },
              historySyncState: {
                deviceId: "stack-001",
                lastAckedHistorySequence: 42,
                lastHistorySyncCompletedAt: null,
                lastHistoryOverflowDetectedAt: null,
              },
            }),
          });
        }

        throw new Error(`unexpected fetch: ${String(url)}`);
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 43,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    await flushBackgroundWork();

    expect(sidecarCommands).toEqual([
      {
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 42,
        max_records: 256,
        request_id: expect.any(String),
      },
    ]);

    const requestId = String(sidecarCommands[0]?.request_id);

    await bridge.handleHistoryError({
      payload: {
        device_id: "stack-001",
        request_id: requestId,
        code: "history.session_unavailable",
        message: "History sync requires an active runtime app session.",
      },
    });

    await flushBackgroundWork();

    expect(sidecarCommands).toHaveLength(1);
  });
});
