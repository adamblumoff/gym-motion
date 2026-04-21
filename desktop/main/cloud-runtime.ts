import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceAnalyticsSnapshot,
  DeviceSummary,
  GatewayRuntimeDeviceSummary,
  GetDeviceAnalyticsInput,
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
          void requestRefresh();
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
