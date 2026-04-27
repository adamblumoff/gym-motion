import type {
  DeviceLogSummary,
  DeviceActivitySummary,
  DeviceSummary,
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

import type { DesktopRuntime } from "./runtime-contract";
import {
  analyticsAffectedDeviceIds,
  createCloudApiClient,
  isDeviceLogSummary,
  isDeviceSummary,
  isMotionUpdatePayload,
  type ApiInvalidateEvent,
  type MotionUpdatePayload,
} from "./cloud-api-client";
import {
  buildCloudSetup,
  buildCloudSnapshot,
  CLOUD_SETUP_MESSAGE,
  mapDeviceToRuntimeSummary,
} from "./cloud-projection";

const SSE_RECONNECT_DELAY_MS = 2_000;

function createUnsupportedError() {
  return new Error(CLOUD_SETUP_MESSAGE);
}

export function createCloudRuntime(baseUrl: string): DesktopRuntime {
  const listeners = new Set<(event: DesktopRuntimeEvent) => void>();
  const normalizedBaseUrl = new URL(baseUrl).toString();
  const api = createCloudApiClient(normalizedBaseUrl);
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
        api.getDevices(),
        api.getEvents(),
        api.getActivity(),
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

  function startEventStream() {
    if (eventStreamTask) {
      return;
    }

    const run = async () => {
      while (!stopped) {
        const abortController = new AbortController();
        eventStreamAbort = abortController;

        try {
          await api.readEventStream(abortController.signal, (invalidateEvent) => {
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
          });
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
      const response = await api.getDeviceAnalytics(input);
      return response.analytics;
    },
    async getDeviceActivity(deviceId: string, limit?: number) {
      const response = await api.getDeviceActivity(deviceId, limit);
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
