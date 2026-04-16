import { describe, expect, it, vi } from "vitest";

import {
  createTelemetryEventHandler,
  parseTelemetryPayload,
} from "./windows-winrt-gateway-telemetry";
import { createRuntimeServer, flushBackgroundWork } from "./windows-winrt-gateway-runtime-bridge.test-support";

describe("windows winrt gateway telemetry", () => {
  it("parses telemetry payloads once and surfaces parse failures cleanly", () => {
    const envelope = parseTelemetryPayload({
      payload_text: '{"deviceId":"node-1","state":"still","timestamp":10}',
    });
    expect(envelope.payloadDeviceId).toBe("node-1");
    expect(envelope.payload).toEqual({
      deviceId: "node-1",
      state: "still",
      timestamp: 10,
    });
    expect(envelope.error).toBeNull();

    const badEnvelope = parseTelemetryPayload({
      payload_text: '{"deviceId":"node-1"',
    });
    expect(badEnvelope.payload).toBeNull();
    expect(badEnvelope.error).toBeInstanceOf(Error);
  });

  it("persists only live motion state transitions", async () => {
    const runtimeServer = createRuntimeServer({
      noteTelemetry: vi.fn(() =>
        Promise.resolve({
          before: { gatewayConnectionState: "connected" },
          after: { gatewayConnectionState: "connected" },
        }),
      ),
    });
    const emitGatewayState = vi.fn();
    const emitRuntimeDeviceUpdated = vi.fn();
    const emitPersistMessage = vi.fn();
    const log = vi.fn();
    const debug = vi.fn();
    let queue = Promise.resolve();
    const queueLiveDeviceTask = vi.fn((_deviceId, work) => {
      queue = queue.then(work, work);
      return queue;
    });
    const handleTelemetryEvent = createTelemetryEventHandler({
      runtimeServer,
      deviceContexts: new Map(),
      emitGatewayState,
      emitRuntimeDeviceUpdated,
      emitPersistMessage,
      queueLiveDeviceTask,
      log,
      debug,
    });

    handleTelemetryEvent({
      payload_text:
        '{"deviceId":"node-1","state":"still","timestamp":10,"delta":12,"snapshot":true}',
      node: { peripheral_id: "peripheral:aa" },
    });
    handleTelemetryEvent({
      payload_text:
        '{"deviceId":"node-1","state":"moving","timestamp":20,"delta":200,"snapshot":false}',
      node: { peripheral_id: "peripheral:aa" },
    });
    handleTelemetryEvent({
      payload_text:
        '{"deviceId":"node-1","state":"moving","timestamp":30,"delta":220,"snapshot":false}',
      node: { peripheral_id: "peripheral:aa" },
    });
    await queue;
    await flushBackgroundWork();

    expect(runtimeServer.noteTelemetry).toHaveBeenCalledTimes(3);
    expect(queueLiveDeviceTask).toHaveBeenCalledTimes(3);
    expect(emitPersistMessage).toHaveBeenCalledTimes(1);
    expect(emitPersistMessage).toHaveBeenCalledWith(
      "persist-motion",
      "node-1",
      expect.objectContaining({
        deviceId: "node-1",
        state: "moving",
        timestamp: 20,
        delta: 200,
      }),
    );
    expect(log).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});
