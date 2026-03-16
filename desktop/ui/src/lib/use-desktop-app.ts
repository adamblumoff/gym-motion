import { startTransition, useEffect, useState } from "react";

import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
} from "@core/contracts";
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
        setup,
      }));
    });

    const unsubscribeRuntime = window.gymMotionDesktop.subscribeRuntime((event) => {
      if (event.type === "setup-updated") {
        setState((current) => ({
          ...current,
          setup: event.setup,
        }));
        return;
      }

      if (event.type === "gateway-updated" || event.type === "device-upserted") {
        setState((current) => ({
          ...current,
          snapshot: applyRuntimeEvent(current.snapshot, event),
        }));
        return;
      }

      startTransition(() => {
        setState((current) => ({
          ...current,
          snapshot: applyRuntimeEvent(current.snapshot, event),
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
    async rescanAdapters() {
      const setup = await window.gymMotionDesktop.rescanAdapters();
      setState((current) => ({
        ...current,
        setup,
      }));
    },
    async requestSilentReconnect() {
      await window.gymMotionDesktop.requestSilentReconnect();
    },
    async setAllowedNodes(nodes: ApprovedNodeRule[]) {
      const setup = await window.gymMotionDesktop.setAllowedNodes(nodes);
      setState((current) => ({
        ...current,
        setup,
      }));
    },
  };
}
