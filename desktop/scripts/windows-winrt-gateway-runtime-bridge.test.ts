import { describe, expect, it } from "vitest";

import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge";

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

  it("keeps raw sidecar logs console-only", () => {
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

    expect(bridge).not.toHaveProperty("handleSidecarLog");
    expect(messages).toEqual([]);
  });

  it("only persists connected and disconnected lifecycle logs", () => {
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
        noteDiscovery() {},
        upsertManualScanCandidate() {},
        noteConnecting() {
          return {
            before: { gatewayConnectionState: "disconnected" },
            after: { gatewayConnectionState: "connecting" },
          };
        },
        noteConnected() {
          return {
            before: { gatewayConnectionState: "connecting" },
            after: {
              gatewayConnectionState: "connected",
              lastTelemetryAt: null,
              lastConnectedAt: null,
              lastDisconnectedAt: null,
            },
          };
        },
        noteDisconnected() {
          return {
            applied: true,
            before: { gatewayConnectionState: "connected", lastTelemetryAt: null },
            after: {
              gatewayConnectionState: "disconnected",
              lastTelemetryAt: null,
              lastConnectedAt: null,
              lastDisconnectedAt: null,
            },
          };
        },
      },
      debug() {},
      sendToDesktop(message) {
        messages.push(message);
        return true;
      },
    });

    bridge.handleNodeDiscovered({
      id: "candidate-1",
      peripheralId: "AA:BB",
      localName: "GymMotion-aabb",
    });

    bridge.handleNodeConnectionState({
      gatewayConnectionState: "connecting",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    bridge.handleNodeConnectionState({
      gatewayConnectionState: "connected",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    bridge.handleNodeConnectionState({
      gatewayConnectionState: "disconnected",
      reason: "ble-disconnected",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    expect(messages).toEqual([
      {
        type: "persist-device-log",
        deviceId: "esp32-known",
        payload: {
          deviceId: "esp32-known",
          level: "info",
          code: "node.connected",
          message: "Gateway connected to GymMotion-aabb.",
          bootId: undefined,
          firmwareVersion: undefined,
          hardwareId: undefined,
          metadata: {
            peripheralId: "AA:BB",
            address: null,
            reconnectAttempt: null,
            reconnectAttemptLimit: null,
            transportStateBefore: "connecting",
            transportStateAfter: "connected",
            lastTelemetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
          },
        },
      },
      {
        type: "persist-device-log",
        deviceId: "esp32-known",
        payload: {
          deviceId: "esp32-known",
          level: "warn",
          code: "node.disconnected",
          message: "Gateway lost GymMotion-aabb.",
          bootId: undefined,
          firmwareVersion: undefined,
          hardwareId: undefined,
          metadata: {
            peripheralId: "AA:BB",
            address: null,
            reason: "ble-disconnected",
            reconnectAttempt: null,
            reconnectAttemptLimit: null,
            reconnectRetryExhausted: null,
            reconnectAwaitingDecision: null,
            transportStateBefore: "connected",
            transportStateAfter: "disconnected",
            lastTelemetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
          },
        },
      },
    ]);
  });
});
