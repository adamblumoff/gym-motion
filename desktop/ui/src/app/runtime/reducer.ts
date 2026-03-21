import type {
  AnalyticsWindow,
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceAnalyticsSnapshot,
} from "@core/contracts";
import { matchesApprovedNodeIdentity } from "@core/approved-node-runtime-match";
import { liveStatusLabelForScan } from "@core/gateway-scan";
import {
  mergeActivityUpdate,
  mergeEventUpdate,
  mergeGatewayDeviceUpdate,
  mergeLogUpdate,
} from "@core/contracts";
import type {
  DesktopRuntimeBatchPatch,
  DesktopRuntimeEvent,
  ThemeState,
} from "@core/services";

import type { DesktopAppState } from "./state";

function analyticsKey(deviceId: string, window: AnalyticsWindow) {
  return `${deviceId}::${window}`;
}

function filterSnapshotToApprovedNodes(
  snapshot: DesktopSnapshot | null,
  approvedNodes: ApprovedNodeRule[] | null,
) {
  if (!snapshot || approvedNodes === null) {
    return snapshot;
  }

  const devices = snapshot.devices.filter((device) =>
    approvedNodes.some((approvedNode) =>
      matchesApprovedNodeIdentity(
        approvedNode,
        {
          knownDeviceId: device.id,
          peripheralId: device.peripheralId ?? null,
          address: device.address ?? null,
          localName: device.advertisedName ?? null,
        },
        approvedNodes,
      ),
    ),
  );

  if (devices.length === snapshot.devices.length) {
    return snapshot;
  }

  const remainingDeviceIds = new Set(devices.map((device) => device.id));
  const connectedNodeCount = devices.filter(
    (device) => device.gatewayConnectionState === "connected",
  ).length;
  const reconnectingNodeCount = devices.filter((device) =>
    ["connecting", "reconnecting"].includes(device.gatewayConnectionState),
  ).length;
  const liveStatus =
    snapshot.runtimeState === "starting"
      ? "Starting gateway runtime…"
      : snapshot.runtimeState === "restarting"
        ? "Restarting gateway runtime…"
        : snapshot.runtimeState === "degraded"
          ? "Gateway degraded"
          : connectedNodeCount > 0
            ? "Gateway live"
            : liveStatusLabelForScan(
                  snapshot.gateway.scanState,
                  snapshot.gateway.scanReason,
                  reconnectingNodeCount,
                ) ??
                (snapshot.gateway.adapterState !== "poweredOn"
                  ? "Waiting for BLE adapter"
                  : "Waiting for approved BLE nodes");

  return {
    ...snapshot,
    liveStatus,
    devices,
    events: snapshot.events.filter((event) => remainingDeviceIds.has(event.deviceId)),
    logs: snapshot.logs.filter((log) => remainingDeviceIds.has(log.deviceId)),
    activities: snapshot.activities.filter((activity) =>
      remainingDeviceIds.has(activity.deviceId),
    ),
    gateway: {
      ...snapshot.gateway,
      connectedNodeCount,
      reconnectingNodeCount,
      knownNodeCount: devices.length,
    },
  };
}

function applyRuntimeEvent(
  previousSnapshot: DesktopSnapshot | null,
  event: DesktopRuntimeEvent,
): DesktopSnapshot | null {
  if (event.type === "snapshot") {
    return event.snapshot;
  }

  if (!previousSnapshot) {
    return previousSnapshot;
  }

  switch (event.type) {
    case "runtime-batch":
      return applyRuntimeBatch(previousSnapshot, event.patch);
    case "gateway-updated":
      return {
        ...previousSnapshot,
        gateway: event.gateway,
        liveStatus: event.liveStatus,
        runtimeState: event.runtimeState,
        gatewayIssue: event.gatewayIssue,
      };
    case "device-upserted":
      return {
        ...previousSnapshot,
        devices: mergeGatewayDeviceUpdate(previousSnapshot.devices, event.device),
      };
    case "event-recorded":
      return {
        ...previousSnapshot,
        events: mergeEventUpdate(previousSnapshot.events, event.event, 14),
      };
    case "log-recorded":
      return {
        ...previousSnapshot,
        logs: mergeLogUpdate(previousSnapshot.logs, event.log, 18),
      };
    case "activity-recorded":
      return {
        ...previousSnapshot,
        activities: mergeActivityUpdate(previousSnapshot.activities, event.activity, 30),
      };
    default:
      return previousSnapshot;
  }
}

function applyRuntimeBatch(
  previousSnapshot: DesktopSnapshot,
  patch: DesktopRuntimeBatchPatch,
): DesktopSnapshot {
  if (patch.replaceSnapshot) {
    return patch.replaceSnapshot;
  }

  let nextSnapshot = previousSnapshot;

  if (patch.gateway) {
    nextSnapshot = {
      ...nextSnapshot,
      gateway: patch.gateway.gateway,
      liveStatus: patch.gateway.liveStatus,
      runtimeState: patch.gateway.runtimeState,
      gatewayIssue: patch.gateway.gatewayIssue,
    };
  }

  if (patch.devices?.length) {
    let devices = nextSnapshot.devices;
    for (const device of patch.devices) {
      devices = mergeGatewayDeviceUpdate(devices, device);
    }
    nextSnapshot = {
      ...nextSnapshot,
      devices,
    };
  }

  if (patch.events?.length) {
    let events = nextSnapshot.events;
    for (const event of patch.events) {
      events = mergeEventUpdate(events, event, 14);
    }
    nextSnapshot = {
      ...nextSnapshot,
      events,
    };
  }

  if (patch.logs?.length) {
    let logs = nextSnapshot.logs;
    for (const log of patch.logs) {
      logs = mergeLogUpdate(logs, log, 18);
    }
    nextSnapshot = {
      ...nextSnapshot,
      logs,
    };
  }

  if (patch.activities?.length) {
    let activities = nextSnapshot.activities;
    for (const activity of patch.activities) {
      activities = mergeActivityUpdate(activities, activity, 30);
    }
    nextSnapshot = {
      ...nextSnapshot,
      activities,
    };
  }

  return nextSnapshot;
}

export function replaceThemeState(
  current: DesktopAppState,
  theme: ThemeState,
): DesktopAppState {
  return {
    ...current,
    theme,
  };
}

export function replaceDeviceAnalytics(
  current: DesktopAppState,
  analytics: DeviceAnalyticsSnapshot,
): DesktopAppState {
  return {
    ...current,
    analyticsByKey: {
      ...current.analyticsByKey,
      [analyticsKey(analytics.deviceId, analytics.window)]: analytics,
    },
  };
}

export function replaceSnapshot(
  current: DesktopAppState,
  snapshot: DesktopSnapshot,
): DesktopAppState {
  return {
    ...current,
    snapshot,
  };
}

export function applySetupState(
  current: DesktopAppState,
  setup: DesktopSetupState,
): DesktopAppState {
  return {
    ...current,
    snapshot: filterSnapshotToApprovedNodes(current.snapshot, setup.approvedNodes),
    setup,
  };
}

export function applyRuntimeEventToState(
  current: DesktopAppState,
  event: DesktopRuntimeEvent,
): DesktopAppState {
  if (event.type === "analytics-updated") {
    return replaceDeviceAnalytics(current, event.analytics);
  }

  return {
    ...current,
    snapshot: filterSnapshotToApprovedNodes(
      applyRuntimeEvent(current.snapshot, event),
      current.setup?.approvedNodes ?? null,
    ),
  };
}
