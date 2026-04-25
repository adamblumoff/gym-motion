import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeviceSummary, MotionEventSummary } from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

import { createCloudRuntime } from "./cloud-runtime";

const baseDevice: DeviceSummary = {
  id: "stack-001",
  lastState: "still",
  lastSeenAt: 1000,
  lastDelta: null,
  updatedAt: "2026-04-25T14:00:00.000Z",
  hardwareId: "hw-1",
  bootId: "boot-1",
  firmwareVersion: "0.5.1",
  machineLabel: "Rack 1",
  siteId: null,
  lastGatewayId: "zone-a",
  lastGatewaySeenAt: "2026-04-25T14:00:00.000Z",
  provisioningState: "provisioned",
  updateStatus: "idle",
  updateTargetVersion: null,
  updateDetail: null,
  updateUpdatedAt: null,
  lastHeartbeatAt: "2026-04-25T14:00:00.000Z",
  lastEventReceivedAt: "2026-04-25T14:00:00.000Z",
  healthStatus: "online",
};

const motionEvent: MotionEventSummary = {
  id: 101,
  deviceId: "stack-001",
  gatewayId: "zone-a",
  sequence: 7,
  state: "moving",
  delta: 12,
  eventTimestamp: 1000,
  receivedAt: "2026-04-25T14:00:01.000Z",
  bootId: "boot-1",
  firmwareVersion: "0.5.1",
  hardwareId: "hw-1",
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function emitSse(controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) {
  controller.enqueue(
    new TextEncoder().encode(`event: invalidate\ndata: ${JSON.stringify(event)}\n\n`),
  );
}

describe("cloud runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies known SSE events without refetching the full cloud snapshot", async () => {
    const fetchPaths: string[] = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = new URL(
          input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url,
        );
        fetchPaths.push(`${url.pathname}${url.search}`);

        switch (url.pathname) {
          case "/api/devices":
            return jsonResponse({ devices: [baseDevice] });
          case "/api/events":
            return jsonResponse({ events: [] });
          case "/api/activity":
            return jsonResponse({ activities: [] });
          case "/api/stream":
            return new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          default:
            return jsonResponse({});
        }
      }),
    );

    const runtime = createCloudRuntime("https://gym-motion.test");
    const events: DesktopRuntimeEvent[] = [];
    runtime.onEvent((event) => {
      events.push(event);
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(fetchPaths).toContain("/api/stream");
    });

    const baselineFetches = [...fetchPaths];
    const updatedDevice = {
      ...baseDevice,
      lastState: "moving",
      updatedAt: "2026-04-25T14:00:01.000Z",
      lastEventReceivedAt: "2026-04-25T14:00:01.000Z",
    } satisfies DeviceSummary;

    emitSse(streamController!, {
      type: "motion-update",
      payload: {
        device: updatedDevice,
        event: motionEvent,
      },
    });

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "runtime-batch")).toBe(true);
      expect(events.some((event) => event.type === "analytics-invalidated")).toBe(true);
    });

    expect(fetchPaths).toEqual(baselineFetches);
    expect(await runtime.getSnapshot()).toMatchObject({
      devices: [expect.objectContaining({ id: "stack-001", lastState: "moving" })],
      events: [expect.objectContaining({ id: 101, deviceId: "stack-001" })],
      activities: [expect.objectContaining({ id: "motion-101", deviceId: "stack-001" })],
    });

    const stopPromise = runtime.stop();
    streamController!.close();
    await stopPromise;
  });
});
