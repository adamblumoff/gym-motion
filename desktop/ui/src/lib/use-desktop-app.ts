import { startTransition, useEffect, useState } from "react";

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

import { applyThemeState, createFallbackThemeState } from "./theme";

type DesktopAppState = {
  snapshot: DesktopSnapshot | null;
  setup: DesktopSetupState | null;
  theme: ThemeState;
};

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

export function useDesktopApp() {
  const [state, setState] = useState<DesktopAppState>({
    snapshot: null,
    setup: null,
    theme: createFallbackThemeState(),
  });

  useEffect(() => {
    let mounted = true;

    void window.gymMotionDesktop.getThemeState().then((themeState) => {
      if (!mounted) {
        return;
      }

      applyThemeState(themeState);
      setState((current) => ({
        ...current,
        theme: themeState,
      }));
    });

    void window.gymMotionDesktop.getSnapshot().then((snapshot) => {
      if (!mounted) {
        return;
      }

      setState((current) => ({
        ...current,
        snapshot,
      }));
    });

    void window.gymMotionDesktop.getSetupState().then((setup) => {
      if (!mounted) {
        return;
      }

      setState((current) => ({
        ...current,
        snapshot: filterSnapshotToApprovedNodes(current.snapshot, setup.approvedNodes),
        setup,
      }));
    });

    const unsubscribeRuntime = window.gymMotionDesktop.subscribeRuntime((event) => {
      if (event.type === "setup-updated") {
        setState((current) => ({
          ...current,
          setup: event.setup,
          snapshot: filterSnapshotToApprovedNodes(
            current.snapshot,
            event.setup.approvedNodes,
          ),
        }));
        return;
      }

      if (event.type === "gateway-updated" || event.type === "device-upserted") {
        setState((current) => ({
          ...current,
          snapshot: filterSnapshotToApprovedNodes(
            applyRuntimeEvent(current.snapshot, event),
            current.setup?.approvedNodes ?? null,
          ),
        }));
        return;
      }

      startTransition(() => {
        setState((current) => ({
          ...current,
          snapshot: filterSnapshotToApprovedNodes(
            applyRuntimeEvent(current.snapshot, event),
            current.setup?.approvedNodes ?? null,
          ),
        }));
      });
    });

    const unsubscribeTheme = window.gymMotionDesktop.subscribeTheme((themeState) => {
      applyThemeState(themeState);
      setState((current) => ({
        ...current,
        theme: themeState,
      }));
    });

    return () => {
      mounted = false;
      unsubscribeRuntime();
      unsubscribeTheme();
    };
  }, []);

  return {
    snapshot: state.snapshot,
    setup: state.setup,
    theme: state.theme,
    async setThemePreference(preference: ThemeState["preference"]) {
      const themeState = await window.gymMotionDesktop.setThemePreference(preference);
      applyThemeState(themeState);
      setState((current) => ({
        ...current,
        theme: themeState,
      }));
    },
    async restartGatewayRuntime() {
      const snapshot = await window.gymMotionDesktop.restartGatewayRuntime();
      setState((current) => ({
        ...current,
        snapshot,
      }));
    },
    async startManualScan() {
      const setup = await window.gymMotionDesktop.startManualScan();
      setState((current) => ({
        ...current,
        snapshot: filterSnapshotToApprovedNodes(current.snapshot, setup.approvedNodes),
        setup,
      }));
    },
    async pairManualCandidate(candidateId: string) {
      const setup = await window.gymMotionDesktop.pairManualCandidate(candidateId);
      setState((current) => ({
        ...current,
        snapshot: filterSnapshotToApprovedNodes(current.snapshot, setup.approvedNodes),
        setup,
      }));
    },
    async recoverApprovedNode(ruleId: string) {
      await window.gymMotionDesktop.recoverApprovedNode(ruleId);
    },
    async resumeApprovedNodeReconnect(ruleId: string) {
      await window.gymMotionDesktop.resumeApprovedNodeReconnect(ruleId);
    },
    async setAllowedNodes(nodes: ApprovedNodeRule[]) {
      const setup = await window.gymMotionDesktop.setAllowedNodes(nodes);
      setState((current) => ({
        ...current,
        snapshot: filterSnapshotToApprovedNodes(current.snapshot, setup.approvedNodes),
        setup,
      }));
    },
  };
}
