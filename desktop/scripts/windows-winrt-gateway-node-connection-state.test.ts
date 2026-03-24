import { describe, expect, it, vi } from "vitest";

import { handleNodeConnectionStateEvent } from "./windows-winrt-gateway-node-connection-state";

describe("windows winrt gateway node connection state handler", () => {
  it("emits reconnecting device updates only after the bridge mutation completes", async () => {
    const snapshots = [];
    const runtimeState = {
      deviceId: "esp32-known",
      gatewayConnectionState: "disconnected",
    };

    const runtimeBridge = {
      handleNodeConnectionState: vi.fn(async () => {
        await Promise.resolve();
        runtimeState.gatewayConnectionState = "reconnecting";
      }),
    };
    const runtimeServer = {
      resolveKnownDeviceId: vi.fn(() => runtimeState.deviceId),
      getRuntimeNode: vi.fn(() => ({ ...runtimeState })),
    };
    const emitGatewayState = vi.fn();
    const emitRuntimeDeviceUpdated = vi.fn((deviceId) => {
      snapshots.push({
        deviceId,
        gatewayConnectionState: runtimeServer.getRuntimeNode(deviceId)?.gatewayConnectionState,
      });
    });

    await handleNodeConnectionStateEvent({
      event: {
        gatewayConnectionState: "connecting",
        node: {
          knownDeviceId: runtimeState.deviceId,
          peripheralId: "AA:BB",
        },
      },
      runtimeBridge,
      runtimeServer,
      emitGatewayState,
      emitRuntimeDeviceUpdated,
      describeNode(node) {
        return node;
      },
    });

    expect(runtimeBridge.handleNodeConnectionState).toHaveBeenCalledTimes(1);
    expect(emitGatewayState).toHaveBeenCalledTimes(1);
    expect(emitRuntimeDeviceUpdated).toHaveBeenCalledWith(runtimeState.deviceId);
    expect(snapshots).toEqual([
      {
        deviceId: runtimeState.deviceId,
        gatewayConnectionState: "reconnecting",
      },
    ]);
  });

  it("waits for reconnecting to publish before a later connected update", async () => {
    const emittedStates = [];
    const runtimeState = {
      deviceId: "esp32-known",
      gatewayConnectionState: "disconnected",
    };

    const runtimeBridge = {
      handleNodeConnectionState: vi.fn(async (event) => {
        await Promise.resolve();
        runtimeState.gatewayConnectionState =
          event.gatewayConnectionState === "connected" ? "connected" : "reconnecting";
      }),
    };
    const runtimeServer = {
      resolveKnownDeviceId: vi.fn(() => runtimeState.deviceId),
      getRuntimeNode: vi.fn(() => ({ ...runtimeState })),
    };
    const emitGatewayState = vi.fn();
    const emitRuntimeDeviceUpdated = vi.fn((deviceId) => {
      emittedStates.push(runtimeServer.getRuntimeNode(deviceId)?.gatewayConnectionState);
    });

    await handleNodeConnectionStateEvent({
      event: {
        gatewayConnectionState: "connecting",
        node: { knownDeviceId: runtimeState.deviceId, peripheralId: "AA:BB" },
      },
      runtimeBridge,
      runtimeServer,
      emitGatewayState,
      emitRuntimeDeviceUpdated,
      describeNode(node) {
        return node;
      },
    });

    await handleNodeConnectionStateEvent({
      event: {
        gatewayConnectionState: "connected",
        node: { knownDeviceId: runtimeState.deviceId, peripheralId: "AA:BB" },
      },
      runtimeBridge,
      runtimeServer,
      emitGatewayState,
      emitRuntimeDeviceUpdated,
      describeNode(node) {
        return node;
      },
    });

    expect(emittedStates).toEqual(["reconnecting", "connected"]);
  });
});
