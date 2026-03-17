import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
} from "@core/contracts";
import { matchesApprovedNodeIdentity } from "@core/approved-node-runtime-match";
import { liveStatusLabelForScan } from "@core/gateway-scan";
import {
  mergeActivityUpdate,
  mergeEventUpdate,
  mergeGatewayDeviceUpdate,
  mergeLogUpdate,
} from "@core/contracts";
import type { DesktopRuntimeEvent, ThemeState } from "@core/services";

import type { DesktopAppState } from "./state";

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

export function replaceThemeState(
  current: DesktopAppState,
  theme: ThemeState,
): DesktopAppState {
  return {
    ...current,
    theme,
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
  return {
    ...current,
    snapshot: filterSnapshotToApprovedNodes(
      applyRuntimeEvent(current.snapshot, event),
      current.setup?.approvedNodes ?? null,
    ),
  };
}
