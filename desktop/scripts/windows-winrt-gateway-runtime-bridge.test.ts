import { describe, expect, it } from "bun:test";

import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge.mjs";

describe("windows winrt gateway runtime bridge", () => {
  it("serializes telemetry forwarding per device while allowing other devices to continue", async () => {
    const messages = [];
    let releaseFirstDevice;

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: {
        noteTelemetry(payload) {
          if (payload.deviceId === "stack-001" && payload.sequence === 1) {
            return new Promise((resolve) => {
              releaseFirstDevice = () =>
                resolve({
                  before: { gatewayConnectionState: "connected" },
                  after: {
                    gatewayConnectionState: "connected",
                    telemetryFreshness: "fresh",
                    lastTelemetryAt: payload.timestamp,
                    lastConnectedAt: null,
                    lastDisconnectedAt: null,
                  },
                });
            });
          }

          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: {
              gatewayConnectionState: "connected",
              telemetryFreshness: "fresh",
              lastTelemetryAt: payload.timestamp,
              lastConnectedAt: null,
              lastDisconnectedAt: null,
            },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop(message) {
        messages.push(message);
        return true;
      },
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
      state: "still",
      timestamp: 2,
      delta: 0,
      sequence: 2,
      bootId: "boot-1",
      firmwareVersion: "0.5.1",
      hardwareId: "hw-1",
    });
    const thirdForward = bridge.forwardTelemetry({
      deviceId: "stack-002",
      state: "moving",
      timestamp: 3,
      delta: 9,
      sequence: 1,
      bootId: "boot-2",
      firmwareVersion: "0.5.1",
      hardwareId: "hw-2",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(messages).toEqual([
      {
        type: "persist-motion",
        deviceId: "stack-002",
        payload: {
          deviceId: "stack-002",
          state: "moving",
          timestamp: 3,
          delta: 9,
          sequence: 1,
          bootId: "boot-2",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-2",
        },
      },
    ]);

    releaseFirstDevice?.();
    await Promise.all([firstForward, secondForward, thirdForward]);

    expect(messages).toEqual([
      {
        type: "persist-motion",
        deviceId: "stack-002",
        payload: {
          deviceId: "stack-002",
          state: "moving",
          timestamp: 3,
          delta: 9,
          sequence: 1,
          bootId: "boot-2",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-2",
        },
      },
      {
        type: "persist-motion",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          state: "moving",
          timestamp: 1,
          delta: 12,
          sequence: 1,
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      },
      {
        type: "persist-motion",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          state: "still",
          timestamp: 2,
          delta: 0,
          sequence: 2,
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      },
    ]);
  });

  it("routes known sidecar logs to per-device persistence and leaves unknown logs console-only", () => {
    const messages = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId(input) {
          if (input?.peripheralId === "AA:BB") {
            return "esp32-known";
          }

          return null;
        },
      },
      debug() {},
      sendToDesktop(message) {
        messages.push(message);
        return true;
      },
    });

    bridge.handleSidecarLog({
      level: "info",
      message: "Reconnect completed for Leg Press.",
      details: {
        peripheralId: "AA:BB",
        reconnect: {
          attempt: 1,
          attempt_limit: 20,
        },
        usedTelemetryFallback: false,
      },
    });

    bridge.handleSidecarLog({
      level: "warn",
      message: "Adapter scan paused while reconnect is active.",
      details: {
        adapterId: "winrt:default",
      },
    });

    expect(messages).toEqual([
      {
        type: "persist-device-log",
        deviceId: "esp32-known",
        payload: {
          deviceId: "esp32-known",
          level: "info",
          code: "node.sidecar_log",
          message: "Reconnect completed for Leg Press.",
          bootId: null,
          firmwareVersion: null,
          hardwareId: null,
          metadata: {
            peripheralId: "AA:BB",
            reconnect: JSON.stringify({
              attempt: 1,
              attempt_limit: 20,
            }),
            usedTelemetryFallback: false,
          },
        },
      },
    ]);
  });
});
