import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceLogSummary,
  DeviceActivitySummary,
  DeviceAnalyticsSnapshot,
  DeviceSummary,
  GatewayRuntimeDeviceSummary,
  GetDeviceAnalyticsInput,
  MotionEventSummary,
} from "@core/contracts";
import {
  mapDeviceLogToActivity,
  mapMotionEventToActivity,
  mergeActivityUpdate,
  mergeDeviceUpdate,
  mergeEventUpdate,
  mergeLogUpdate,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

import {
  createEmptySetupState,
  createEmptySnapshot,
  offlineGatewaySnapshot,
} from "./runtime-snapshot";
import type { DesktopRuntime } from "./runtime-contract";

const REQUEST_TIMEOUT_MS = 10_000;
const SSE_RECONNECT_DELAY_MS = 2_000;
const CLOUD_SETUP_MESSAGE =
  "Cloud mode is active. Sensor setup now lives on Linux gateways, so this desktop build is read-only for BLE pairing.";

type DevicesResponse = {
  devices: DeviceSummary[];
};

type EventsResponse = {
  events: DesktopSnapshot["events"];
};

type ActivityResponse = {
  activities: DeviceActivitySummary[];
};

type DeviceAnalyticsResponse = {
  analytics: DeviceAnalyticsSnapshot;
};

type ApiInvalidateEvent = {
  type?: string;
  payload?: unknown;
};

type MotionUpdatePayload = {
  device: DeviceSummary;
  event?: MotionEventSummary;
};

function approvedRuleFromDevice(device: DeviceSummary): ApprovedNodeRule {
  return {
    id: device.id,
    label: device.machineLabel ?? device.id,
    peripheralId: null,
    address: null,
    localName: null,
    knownDeviceId: device.id,
  };
}

function mapHealthToConnectionState(
  healthStatus: DeviceSummary["healthStatus"],
): GatewayRuntimeDeviceSummary["gatewayConnectionState"] {
  switch (healthStatus) {
    case "online":
    case "stale":
      return "connected";
    default:
      return "disconnected";
  }
}

function mapHealthToFreshness(
  healthStatus: DeviceSummary["healthStatus"],
): GatewayRuntimeDeviceSummary["telemetryFreshness"] {
  switch (healthStatus) {
    case "online":
      return "fresh";
    case "stale":
      return "stale";
    default:
      return "missing";
  }
}

function mapDeviceToRuntimeSummary(device: DeviceSummary): GatewayRuntimeDeviceSummary {
  return {
    ...device,
    gatewayConnectionState: mapHealthToConnectionState(device.healthStatus),
    telemetryFreshness: mapHealthToFreshness(device.healthStatus),
    sensorIssue: device.healthStatus === "offline" ? "No recent cloud heartbeat." : null,
    peripheralId: null,
    address: null,
    gatewayLastAdvertisementAt: null,
    gatewayLastConnectedAt: device.lastHeartbeatAt ?? device.lastEventReceivedAt,
    gatewayLastDisconnectedAt: device.healthStatus === "offline" ? device.updatedAt : null,
    gatewayLastTelemetryAt: device.lastEventReceivedAt ?? device.lastHeartbeatAt,
    gatewayDisconnectReason:
      device.healthStatus === "offline" ? "No recent gateway update reached the backend." : null,
    advertisedName: device.machineLabel,
    lastRssi: null,
    otaStatus: device.updateStatus,
    otaTargetVersion: device.updateTargetVersion,
    otaProgressBytesSent: null,
    otaTotalBytes: null,
    otaLastPhase: null,
    otaFailureDetail: device.updateStatus === "failed" ? device.updateDetail : null,
    otaLastStatusMessage: device.updateDetail,
    otaUpdatedAt: device.updateUpdatedAt,
    reconnectAttempt: 0,
    reconnectAttemptLimit: 0,
    reconnectRetryExhausted: false,
    reconnectAwaitingDecision: false,
  };
}

async function fetchCloudJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-store",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}`);
  }

  return (await response.json()) as T;
}

function buildCloudSetup(devices: DeviceSummary[]): DesktopSetupState {
  return {
    ...createEmptySetupState(),
    adapterIssue: CLOUD_SETUP_MESSAGE,
    approvedNodes: devices.map(approvedRuleFromDevice),
  };
}

function buildCloudSnapshot(baseUrl: string, devices: DeviceSummary[], args: {
  events: DesktopSnapshot["events"];
  activities: DeviceActivitySummary[];
  gatewayIssue: string | null;
}): DesktopSnapshot {
  const runtimeDevices = devices.map(mapDeviceToRuntimeSummary);
  const connectedNodeCount = runtimeDevices.filter(
    (device) => device.gatewayConnectionState === "connected",
  ).length;
  const updatedAtCandidates = [
    ...devices.map((device) => device.updatedAt),
    ...args.events.map((event) => event.receivedAt),
    ...args.activities.map((activity) => activity.receivedAt),
  ]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const gatewayUpdatedAt =
    updatedAtCandidates.length > 0
      ? new Date(Math.max(...updatedAtCandidates)).toISOString()
      : new Date(0).toISOString();
  const gateway = {
    ...offlineGatewaySnapshot(),
    hostname: new URL(baseUrl).hostname,
    mode: "cloud-http-backend",
    sessionId: new URL(baseUrl).host,
    adapterState: "remote",
    scanState: "remote",
    connectedNodeCount,
    reconnectingNodeCount: 0,
    knownNodeCount: runtimeDevices.length,
    updatedAt: gatewayUpdatedAt,
  };
  const runtimeState = args.gatewayIssue ? "degraded" : "running";
  const liveStatus = args.gatewayIssue
    ? "Cloud backend unavailable"
    : connectedNodeCount > 0
      ? "Cloud data live"
      : runtimeDevices.length > 0
        ? "Cloud backend connected"
        : "Waiting for cloud device data";
  const snapshot = {
    ...createEmptySnapshot(),
    trayHint: "Desktop reads from the cloud backend. BLE runs on Linux gateways.",
    liveStatus,
    runtimeState,
    gatewayIssue: args.gatewayIssue,
    gateway,
    devices: runtimeDevices,
    events: args.events,
    activities: args.activities,
  } satisfies DesktopSnapshot;

  return snapshot;
}

function createUnsupportedError() {
  return new Error(CLOUD_SETUP_MESSAGE);
}

function parseInvalidateEvent(lines: string[]) {
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as ApiInvalidateEvent;
  } catch {
    return null;
  }
}

function analyticsAffectedDeviceIds(event: ApiInvalidateEvent | null) {
  if (!event) {
    return [];
  }

  const deviceIds = new Set<string>();
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  const nestedDevice =
    payload?.device && typeof payload.device === "object"
      ? (payload.device as Record<string, unknown>)
      : null;
  const payloadDeviceId = payload?.deviceId;
  const nestedDeviceId = nestedDevice?.id;

  if (typeof payloadDeviceId === "string" && payloadDeviceId.length > 0) {
    deviceIds.add(payloadDeviceId);
  }

  if (typeof nestedDeviceId === "string" && nestedDeviceId.length > 0) {
    deviceIds.add(nestedDeviceId);
  }

  return [...deviceIds];
}

function isDeviceSummary(value: unknown): value is DeviceSummary {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as DeviceSummary).id === "string" &&
      typeof (value as DeviceSummary).updatedAt === "string" &&
      typeof (value as DeviceSummary).healthStatus === "string",
  );
}

function isMotionEventSummary(value: unknown): value is MotionEventSummary {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as MotionEventSummary).id === "number" &&
      typeof (value as MotionEventSummary).deviceId === "string" &&
      typeof (value as MotionEventSummary).receivedAt === "string",
  );
}

function isDeviceLogSummary(value: unknown): value is DeviceLogSummary {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as DeviceLogSummary).id === "number" &&
      typeof (value as DeviceLogSummary).deviceId === "string" &&
      typeof (value as DeviceLogSummary).receivedAt === "string",
  );
}

function isMotionUpdatePayload(value: unknown): value is MotionUpdatePayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Partial<MotionUpdatePayload>;
  return isDeviceSummary(payload.device) && (
    payload.event === undefined || isMotionEventSummary(payload.event)
  );
}

export function createCloudRuntime(baseUrl: string): DesktopRuntime {
  const listeners = new Set<(event: DesktopRuntimeEvent) => void>();
  const normalizedBaseUrl = new URL(baseUrl).toString();
  let eventStreamAbort: AbortController | null = null;
  let eventStreamTask: Promise<void> | null = null;
  let refreshTask: Promise<void> | null = null;
  let refreshPending = false;
  let pendingForceEmit = false;
  let stopped = false;
  let devices: DeviceSummary[] = [];
  let snapshot = buildCloudSnapshot(normalizedBaseUrl, [], {
    events: [],
    activities: [],
    gatewayIssue: null,
  });
  let setup = buildCloudSetup([]);
  let lastSnapshotKey = JSON.stringify(snapshot);
  let lastSetupKey = JSON.stringify(setup);

  function emit(event: DesktopRuntimeEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function syncStateKeys() {
    lastSnapshotKey = JSON.stringify(snapshot);
    lastSetupKey = JSON.stringify(setup);
  }

  function updateSetupFromDevices(nextDevices: DeviceSummary[]) {
    const nextSetup = buildCloudSetup(nextDevices);
    const nextSetupKey = JSON.stringify(nextSetup);
    setup = nextSetup;

    if (nextSetupKey !== lastSetupKey) {
      lastSetupKey = nextSetupKey;
      emit({
        type: "setup-updated",
        setup,
      });
    }
  }

  function commitCloudPatch(args: {
    nextDevices?: DeviceSummary[];
    events?: MotionEventSummary[];
    logs?: DeviceLogSummary[];
    activities?: DeviceActivitySummary[];
  }) {
    const nextDevices = args.nextDevices ?? devices;
    const nextEvents = args.events?.reduce(
      (current, event) => mergeEventUpdate(current, event, 14),
      snapshot.events,
    ) ?? snapshot.events;
    const nextLogs = args.logs?.reduce(
      (current, log) => mergeLogUpdate(current, log, 18),
      snapshot.logs,
    ) ?? snapshot.logs;
    const nextActivities = args.activities?.reduce(
      (current, activity) => mergeActivityUpdate(current, activity, 30),
      snapshot.activities,
    ) ?? snapshot.activities;
    const previousSnapshot = snapshot;
    const nextSnapshot = buildCloudSnapshot(normalizedBaseUrl, nextDevices, {
      events: nextEvents,
      activities: nextActivities,
      gatewayIssue: null,
    });
    const runtimeDevices = nextDevices.map(mapDeviceToRuntimeSummary);

    devices = nextDevices;
    snapshot = {
      ...nextSnapshot,
      logs: nextLogs,
    };
    syncStateKeys();
    updateSetupFromDevices(nextDevices);

    emit({
      type: "runtime-batch",
      patch: {
        gateway:
          nextSnapshot.gateway.updatedAt !== previousSnapshot.gateway.updatedAt ||
          nextSnapshot.liveStatus !== previousSnapshot.liveStatus ||
          nextSnapshot.runtimeState !== previousSnapshot.runtimeState ||
          nextSnapshot.gatewayIssue !== previousSnapshot.gatewayIssue
            ? {
                gateway: nextSnapshot.gateway,
                liveStatus: nextSnapshot.liveStatus,
                runtimeState: nextSnapshot.runtimeState,
                gatewayIssue: nextSnapshot.gatewayIssue,
              }
            : undefined,
        devices: runtimeDevices.filter((device) => {
          const previous = previousSnapshot.devices.find((entry) => entry.id === device.id);
          return JSON.stringify(previous) !== JSON.stringify(device);
        }),
        events: args.events,
        logs: args.logs,
        activities: args.activities,
      },
    });
  }

  function applyDeviceUpdate(device: DeviceSummary) {
    commitCloudPatch({
      nextDevices: mergeDeviceUpdate(devices, device),
    });
  }

  function applyMotionUpdate(payload: MotionUpdatePayload) {
    commitCloudPatch({
      nextDevices: mergeDeviceUpdate(devices, payload.device),
      events: payload.event ? [payload.event] : undefined,
      activities: payload.event ? [mapMotionEventToActivity(payload.event)] : undefined,
    });
  }

  function applyDeviceLog(log: DeviceLogSummary) {
    commitCloudPatch({
      logs: [log],
      activities: [mapDeviceLogToActivity(log)],
    });
  }

  function applyApiInvalidateEvent(event: ApiInvalidateEvent | null) {
    if (!event) {
      return false;
    }

    switch (event.type) {
      case "device-updated":
        if (isDeviceSummary(event.payload)) {
          applyDeviceUpdate(event.payload);
          return true;
        }
        return false;
      case "motion-update":
        if (isMotionUpdatePayload(event.payload)) {
          applyMotionUpdate(event.payload);
          return true;
        }
        return false;
      case "device-log":
        if (isDeviceLogSummary(event.payload)) {
          applyDeviceLog(event.payload);
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  async function refresh(forceEmit = false) {
    try {
      const [devicesResponse, eventsResponse, activityResponse] = await Promise.all([
        fetchCloudJson<DevicesResponse>(normalizedBaseUrl, "/api/devices"),
        fetchCloudJson<EventsResponse>(normalizedBaseUrl, "/api/events?limit=14"),
        fetchCloudJson<ActivityResponse>(normalizedBaseUrl, "/api/activity?limit=30"),
      ]);

      const nextSnapshot = buildCloudSnapshot(normalizedBaseUrl, devicesResponse.devices, {
        events: eventsResponse.events,
        activities: activityResponse.activities,
        gatewayIssue: null,
      });
      const nextSetup = buildCloudSetup(devicesResponse.devices);
      const nextSnapshotKey = JSON.stringify(nextSnapshot);
      const nextSetupKey = JSON.stringify(nextSetup);

      devices = devicesResponse.devices;
      snapshot = nextSnapshot;
      setup = nextSetup;

      if (forceEmit || nextSnapshotKey !== lastSnapshotKey) {
        lastSnapshotKey = nextSnapshotKey;
        emit({
          type: "snapshot",
          snapshot,
        });
      }

      if (forceEmit || nextSetupKey !== lastSetupKey) {
        lastSetupKey = nextSetupKey;
        emit({
          type: "setup-updated",
          setup,
        });
      }
    } catch (error) {
      const gatewayIssue =
        error instanceof Error ? error.message : "Cloud backend request failed.";
      const nextSnapshot = buildCloudSnapshot(normalizedBaseUrl, devices, {
        events: snapshot.events,
        activities: snapshot.activities,
        gatewayIssue,
      });
      const nextSnapshotKey = JSON.stringify(nextSnapshot);
      snapshot = nextSnapshot;

      if (forceEmit || nextSnapshotKey !== lastSnapshotKey) {
        lastSnapshotKey = nextSnapshotKey;
        emit({
          type: "snapshot",
          snapshot,
        });
      }
    }
  }

  function requestRefresh(forceEmit = false) {
    refreshPending = true;
    pendingForceEmit ||= forceEmit;

    if (refreshTask) {
      return refreshTask;
    }

    const run = async () => {
      while (refreshPending) {
        const nextForceEmit = pendingForceEmit;
        refreshPending = false;
        pendingForceEmit = false;
        await refresh(nextForceEmit);
      }
    };

    refreshTask = run().finally(() => {
      refreshTask = null;
    });

    return refreshTask;
  }

  async function readEventStream(signal: AbortSignal) {
    const response = await fetch(new URL("/api/stream", normalizedBaseUrl), {
      cache: "no-store",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-store",
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`/api/stream -> ${response.status}`);
    }

    if (!response.body) {
      throw new Error("/api/stream did not provide a response body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const normalizedBuffer = buffer.replace(/\r\n/g, "\n");
        const boundary = normalizedBuffer.indexOf("\n\n");
        if (boundary < 0) {
          buffer = normalizedBuffer;
          break;
        }

        const rawEvent = normalizedBuffer.slice(0, boundary);
        buffer = normalizedBuffer.slice(boundary + 2);
        const lines = rawEvent
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const eventType =
          lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ??
          "message";

        if (eventType === "invalidate") {
          const invalidateEvent = parseInvalidateEvent(lines);
          const deviceIds = analyticsAffectedDeviceIds(invalidateEvent);
          if (deviceIds.length > 0) {
            emit({
              type: "analytics-invalidated",
              deviceIds,
            });
          }
          if (!applyApiInvalidateEvent(invalidateEvent)) {
            void requestRefresh();
          }
        }
      }
    }
  }

  function startEventStream() {
    if (eventStreamTask) {
      return;
    }

    const run = async () => {
      while (!stopped) {
        const abortController = new AbortController();
        eventStreamAbort = abortController;

        try {
          await readEventStream(abortController.signal);
        } catch (error) {
          if (!abortController.signal.aborted && !stopped) {
            console.warn("[cloud-runtime] event stream disconnected", error);
          }
        } finally {
          if (eventStreamAbort === abortController) {
            eventStreamAbort = null;
          }
        }

        if (stopped) {
          break;
        }

        await requestRefresh();
        await new Promise((resolve) => setTimeout(resolve, SSE_RECONNECT_DELAY_MS));
      }
    };

    eventStreamTask = run().finally(() => {
      eventStreamTask = null;
    });
  }

  return {
    async start() {
      stopped = false;
      await requestRefresh(true);
      startEventStream();
    },
    async stop() {
      stopped = true;
      eventStreamAbort?.abort();
      await eventStreamTask;
      await refreshTask;
    },
    async restart() {
      await requestRefresh(true);
      return snapshot;
    },
    async getSnapshot() {
      return snapshot;
    },
    async getSetupState() {
      return setup;
    },
    async startManualScan() {
      throw createUnsupportedError();
    },
    async pairDiscoveredNode() {
      throw createUnsupportedError();
    },
    async pairManualCandidate() {
      throw createUnsupportedError();
    },
    async forgetNode() {
      throw createUnsupportedError();
    },
    async recoverApprovedNode() {
      throw createUnsupportedError();
    },
    async resumeReconnectForNode() {
      throw createUnsupportedError();
    },
    async resumeApprovedNodeReconnect() {
      throw createUnsupportedError();
    },
    async setAllowedNodes() {
      throw createUnsupportedError();
    },
    async getDeviceAnalytics(input: GetDeviceAnalyticsInput) {
      const response = await fetchCloudJson<DeviceAnalyticsResponse>(
        normalizedBaseUrl,
        `/api/device-analytics?deviceId=${encodeURIComponent(input.deviceId)}&window=${encodeURIComponent(
          input.window,
        )}`,
      );
      return response.analytics;
    },
    async getDeviceActivity(deviceId: string, limit?: number) {
      const response = await fetchCloudJson<ActivityResponse>(
        normalizedBaseUrl,
        `/api/device-activity?deviceId=${encodeURIComponent(deviceId)}&limit=${limit ?? 60}`,
      );
      return response.activities;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
