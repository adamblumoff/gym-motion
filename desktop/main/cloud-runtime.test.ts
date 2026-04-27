import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DeviceActivitySummary,
  DeviceAnalyticsSnapshot,
  DeviceLogSummary,
  DeviceSummary,
  MotionEventSummary,
} from "@core/contracts";
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

const lifecycleLog: DeviceLogSummary = {
  id: 201,
  deviceId: "stack-001",
  gatewayId: "zone-a",
  sequence: 8,
  level: "warn",
  code: "battery-low",
  message: "Battery is low.",
  bootId: "boot-1",
  firmwareVersion: "0.5.1",
  hardwareId: "hw-1",
  deviceTimestamp: 1200,
  metadata: null,
  receivedAt: "2026-04-25T14:00:02.000Z",
};

const activity: DeviceActivitySummary = {
  id: "motion-101",
  deviceId: "stack-001",
  gatewayId: "zone-a",
  sequence: 7,
  kind: "motion",
  title: "Movement detected",
  message: "Rack 1 changed to moving.",
  state: "moving",
  level: null,
  code: null,
  delta: 12,
  eventTimestamp: 1000,
  receivedAt: "2026-04-25T14:00:01.000Z",
  bootId: "boot-1",
  firmwareVersion: "0.5.1",
  hardwareId: "hw-1",
  metadata: null,
};

const analytics: DeviceAnalyticsSnapshot = {
  deviceId: "stack-001",
  window: "24h",
  generatedAt: "2026-04-25T14:05:00.000Z",
  source: "canonical",
  buckets: [],
  totalMovementCount: 1,
  totalMovingSeconds: 12,
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

function createCloudHarness() {
  const fetchPaths: string[] = [];
  let devices = [baseDevice];
  let events: MotionEventSummary[] = [];
  let activities: DeviceActivitySummary[] = [];
  let failDevices = false;
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
          return failDevices
            ? new Response("unavailable", { status: 503 })
            : jsonResponse({ devices });
        case "/api/events":
          return jsonResponse({ events });
        case "/api/activity":
        case "/api/device-activity":
          return jsonResponse({ activities });
        case "/api/device-analytics":
          return jsonResponse({ analytics });
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

  return {
    fetchPaths,
    setDevices(nextDevices: DeviceSummary[]) {
      devices = nextDevices;
    },
    setEvents(nextEvents: MotionEventSummary[]) {
      events = nextEvents;
    },
    setActivities(nextActivities: DeviceActivitySummary[]) {
      activities = nextActivities;
    },
    failDevices() {
      failDevices = true;
    },
    emitInvalidate(event: unknown) {
      emitSse(streamController!, event);
    },
    closeStream() {
      streamController?.close();
    },
  };
}

describe("cloud runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the initial cloud snapshot and read-only setup state on start", async () => {
    const cloud = createCloudHarness();
    cloud.setEvents([motionEvent]);
    cloud.setActivities([activity]);
    const runtime = createCloudRuntime("https://gym-motion.test");
    const runtimeEvents: DesktopRuntimeEvent[] = [];
    runtime.onEvent((event) => {
      runtimeEvents.push(event);
    });

    await runtime.start();

    expect(cloud.fetchPaths).toEqual([
      "/api/devices",
      "/api/events?limit=14",
      "/api/activity?limit=30",
      "/api/stream",
    ]);
    expect(await runtime.getSnapshot()).toMatchObject({
      liveStatus: "Cloud data live",
      gateway: expect.objectContaining({
        hostname: "gym-motion.test",
        mode: "cloud-http-backend",
        connectedNodeCount: 1,
        knownNodeCount: 1,
      }),
      devices: [expect.objectContaining({ id: "stack-001", gatewayConnectionState: "connected" })],
      events: [expect.objectContaining({ id: 101 })],
      activities: [expect.objectContaining({ id: "motion-101" })],
    });
    expect(await runtime.getSetupState()).toMatchObject({
      adapterIssue: expect.stringContaining("Cloud mode is active"),
      approvedNodes: [expect.objectContaining({ id: "stack-001", knownDeviceId: "stack-001" })],
    });
    expect(runtimeEvents.map((event) => event.type)).toEqual(["snapshot", "setup-updated"]);

    const stopPromise = runtime.stop();
    cloud.closeStream();
    await stopPromise;
  });

  it("applies known SSE events without refetching the full cloud snapshot", async () => {
    const cloud = createCloudHarness();
    const runtime = createCloudRuntime("https://gym-motion.test");
    const events: DesktopRuntimeEvent[] = [];
    runtime.onEvent((event) => {
      events.push(event);
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(cloud.fetchPaths).toContain("/api/stream");
    });

    const baselineFetches = [...cloud.fetchPaths];
    const updatedDevice = {
      ...baseDevice,
      lastState: "moving",
      updatedAt: "2026-04-25T14:00:01.000Z",
      lastEventReceivedAt: "2026-04-25T14:00:01.000Z",
    } satisfies DeviceSummary;

    cloud.emitInvalidate({
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

    expect(cloud.fetchPaths).toEqual(baselineFetches);
    expect(await runtime.getSnapshot()).toMatchObject({
      devices: [expect.objectContaining({ id: "stack-001", lastState: "moving" })],
      events: [expect.objectContaining({ id: 101, deviceId: "stack-001" })],
      activities: [expect.objectContaining({ id: "motion-101", deviceId: "stack-001" })],
    });

    const stopPromise = runtime.stop();
    cloud.closeStream();
    await stopPromise;
  });

  it("degrades without dropping the last known cloud snapshot when refresh fails", async () => {
    const cloud = createCloudHarness();
    cloud.setEvents([motionEvent]);
    cloud.setActivities([activity]);
    const runtime = createCloudRuntime("https://gym-motion.test");

    await runtime.start();
    cloud.failDevices();

    await runtime.restart();

    expect(await runtime.getSnapshot()).toMatchObject({
      runtimeState: "degraded",
      liveStatus: "Cloud backend unavailable",
      gatewayIssue: "/api/devices -> 503",
      devices: [expect.objectContaining({ id: "stack-001" })],
      events: [expect.objectContaining({ id: 101 })],
      activities: [expect.objectContaining({ id: "motion-101" })],
    });

    const stopPromise = runtime.stop();
    cloud.closeStream();
    await stopPromise;
  });

  it("refreshes once when an SSE invalidation cannot be applied locally", async () => {
    const cloud = createCloudHarness();
    const runtime = createCloudRuntime("https://gym-motion.test");

    await runtime.start();
    await vi.waitFor(() => {
      expect(cloud.fetchPaths).toContain("/api/stream");
    });
    const baselineFetchCount = cloud.fetchPaths.length;
    const refreshedDevice = {
      ...baseDevice,
      machineLabel: "Rack 1 refreshed",
      updatedAt: "2026-04-25T14:00:03.000Z",
    } satisfies DeviceSummary;
    cloud.setDevices([refreshedDevice]);

    cloud.emitInvalidate({ type: "unknown-cloud-event", payload: { deviceId: "stack-001" } });

    await vi.waitFor(async () => {
      expect((await runtime.getSnapshot()).devices[0]?.machineLabel).toBe("Rack 1 refreshed");
    });
    expect(cloud.fetchPaths.slice(baselineFetchCount)).toEqual([
      "/api/devices",
      "/api/events?limit=14",
      "/api/activity?limit=30",
    ]);

    const stopPromise = runtime.stop();
    cloud.closeStream();
    await stopPromise;
  });

  it("applies device log SSE events without refetching the full cloud snapshot", async () => {
    const cloud = createCloudHarness();
    const runtime = createCloudRuntime("https://gym-motion.test");

    await runtime.start();
    await vi.waitFor(() => {
      expect(cloud.fetchPaths).toContain("/api/stream");
    });
    const baselineFetches = [...cloud.fetchPaths];

    cloud.emitInvalidate({
      type: "device-log",
      payload: lifecycleLog,
    });

    await vi.waitFor(async () => {
      expect((await runtime.getSnapshot()).logs).toEqual([lifecycleLog]);
    });
    expect(cloud.fetchPaths).toEqual(baselineFetches);
    expect(await runtime.getSnapshot()).toMatchObject({
      activities: [expect.objectContaining({ id: "log-201", deviceId: "stack-001" })],
    });

    const stopPromise = runtime.stop();
    cloud.closeStream();
    await stopPromise;
  });

  it("reads analytics and device activity through the cloud runtime interface", async () => {
    const cloud = createCloudHarness();
    cloud.setActivities([activity]);
    const runtime = createCloudRuntime("https://gym-motion.test");

    const analyticsResult = await runtime.getDeviceAnalytics({
      deviceId: "stack-001",
      window: "24h",
    });
    const activityResult = await runtime.getDeviceActivity("stack-001", 12);

    expect(analyticsResult).toEqual(analytics);
    expect(activityResult).toEqual([activity]);
    expect(cloud.fetchPaths).toEqual([
      "/api/device-analytics?deviceId=stack-001&window=24h",
      "/api/device-activity?deviceId=stack-001&limit=12",
    ]);

    const stopPromise = runtime.stop();
    cloud.closeStream();
    await stopPromise;
  });
});
