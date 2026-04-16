import { describe, expect, it, vi } from "vitest";

import {
  applyNodeConnectionStateEvent,
  getGatewayConnectionState,
} from "./windows-winrt-gateway-connection";
import { createRuntimeServer } from "./windows-winrt-gateway-runtime-bridge.test-support";

describe("windows winrt gateway connection", () => {
  it("normalizes the gateway connection state", () => {
    expect(getGatewayConnectionState({ gateway_connection_state: "reconnecting" })).toBe(
      "reconnecting",
    );
    expect(getGatewayConnectionState({ gatewayConnectionState: "connected" })).toBe("connected");
    expect(getGatewayConnectionState({})).toBe("disconnected");
  });

  it("applies a connected event and updates runtime/device context state", () => {
    const runtimeServer = createRuntimeServer({
      resolveKnownDeviceId: vi.fn(() => "known-node"),
      noteConnected: vi.fn(),
    });
    const deviceContexts = new Map();
    const emitGatewayState = vi.fn();
    const emitRuntimeDeviceUpdated = vi.fn();

    applyNodeConnectionStateEvent(
      {
        gateway_connection_state: "connected",
        node: {
          peripheral_id: "peripheral:aa",
          address: "AA",
          local_name: "Gym Motion",
          last_rssi: -51,
        },
      },
      {
        runtimeServer,
        deviceContexts,
        emitGatewayState,
        emitRuntimeDeviceUpdated,
      },
    );

    expect(runtimeServer.noteConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: null,
        knownDeviceId: null,
        peripheralId: "peripheral:aa",
        address: "AA",
        localName: "Gym Motion",
        rssi: -51,
      }),
    );
    expect(deviceContexts.get("known-node")).toEqual(
      expect.objectContaining({
        deviceId: "known-node",
        peripheralId: "peripheral:aa",
        address: "AA",
        advertisedName: "Gym Motion",
        rssi: -51,
        lastGatewayConnectionState: "connected",
      }),
    );
    expect(emitGatewayState).toHaveBeenCalledTimes(1);
    expect(emitRuntimeDeviceUpdated).toHaveBeenCalledWith("known-node");
  });
});
