import { describe, expect, it } from "bun:test";

import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge.mjs";

function createMockResponse(body = { ok: true }) {
  return {
    ok: true,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe("windows winrt gateway runtime bridge", () => {
  it("serializes telemetry forwarding so repeated state updates do not overlap localhost writes", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    let resolveFirstFetch;

    globalThis.fetch = (async (url, init) => {
      fetchCalls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });

      if (fetchCalls.length === 1) {
        return await new Promise((resolve) => {
          resolveFirstFetch = () => resolve(createMockResponse());
        });
      }

      return createMockResponse();
    });

    try {
      const bridge = createRuntimeBridge({
        config: {
          apiBaseUrl: "http://127.0.0.1:3000",
          heartbeatMinIntervalMs: 10_000,
        },
        runtimeServer: {
          noteTelemetry(payload) {
            return {
              before: { gatewayConnectionState: "connected" },
              after: {
                gatewayConnectionState: "connected",
                telemetryFreshness: "fresh",
                lastTelemetryAt: payload.timestamp,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
              },
            };
          },
          resolveKnownDeviceId() {
            return null;
          },
        },
        debug() {},
      });

      const firstForward = bridge.forwardTelemetry({
        deviceId: "stack-001",
        state: "moving",
        timestamp: 1,
        delta: 12,
        sequence: 1,
        bootId: "boot-1",
        firmwareVersion: "0.5.1",
        hardwareId: "hw-1",
      });
      const secondForward = bridge.forwardTelemetry({
        deviceId: "stack-001",
        state: "moving",
        timestamp: 2,
        delta: 14,
        sequence: 2,
        bootId: "boot-1",
        firmwareVersion: "0.5.1",
        hardwareId: "hw-1",
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:3000/api/ingest");

      resolveFirstFetch?.();
      await Promise.all([firstForward, secondForward]);

      expect(fetchCalls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
