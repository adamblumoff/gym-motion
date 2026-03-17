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

  it("keeps connection lifecycle state out of persisted analytics logs", () => {
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

    expect(messages).toEqual([]);
  });
});
