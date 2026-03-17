import type {
  DesktopSetupState,
  DesktopSnapshot,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

import {
  listDeviceActivity,
  listDeviceLogs,
  listRecentEvents,
} from "../../../backend/data";
import type { ManualScanPayload } from "./common";
import { fetchJson } from "./common";
import { normalizeGatewayHealth } from "./snapshot";

type RuntimeSyncDeps = {
  getChild: () => { killed?: boolean } | null;
  getRuntimePort: () => number;
  getSnapshot: () => DesktopSnapshot;
  setSnapshot: (snapshot: DesktopSnapshot) => void;
  getSetupState: () => DesktopSetupState;
  updateGatewayStatus: (
    gateway: GatewayStatusSummary,
    runtimeState: "starting" | "running" | "degraded" | "restarting",
    gatewayIssue: string | null,
  ) => void;
  refreshAdapters: () => Promise<void>;
  applyManualScanPayload: (payload: ManualScanPayload) => void;
  pruneSnapshot: (snapshot: DesktopSnapshot) => DesktopSnapshot;
  emit: (event: DesktopRuntimeEvent) => void;
};

export type RuntimeSync = {
  refreshManualScanState: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  refreshGatewayState: () => Promise<void>;
};

async function loadSnapshotHistory(devices: GatewayRuntimeDeviceSummary[]) {
  const [events, logs] = await Promise.all([
    listRecentEvents(14),
    listDeviceLogs({ limit: 18 }),
  ]);
  const activityGroups = await Promise.all(
    devices.map((device) => listDeviceActivity({ deviceId: device.id, limit: 12 })),
  );
  const activities = activityGroups
    .flat()
    .toSorted(
      (left, right) =>
        new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime(),
    )
    .slice(0, 30);

  return {
    events,
    logs,
    activities,
  };
}

export function createRuntimeSync(deps: RuntimeSyncDeps): RuntimeSync {
  async function refreshManualScanState() {
    if (!deps.getChild()) {
      deps.applyManualScanPayload({
        state: "idle",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      });
      return;
    }

    const manualScanPayload = await fetchJson<ManualScanPayload>(
      `http://127.0.0.1:${deps.getRuntimePort()}/manual-scan`,
    );

    deps.applyManualScanPayload(manualScanPayload);
  }

  async function refreshHistory() {
    const snapshot = deps.getSnapshot();
    const history = await loadSnapshotHistory(snapshot.devices);

    deps.setSnapshot({
      ...snapshot,
      ...history,
    });
  }

  async function refreshGatewayState() {
    if (!deps.getChild()) {
      deps.applyManualScanPayload({
        state: "idle",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      });
      return;
    }

    const runtimePort = deps.getRuntimePort();
    const baseUrl = `http://127.0.0.1:${runtimePort}`;

    try {
      const [healthPayload, devicesPayload] = await Promise.all([
        fetchJson<{ ok: boolean; gateway: GatewayStatusSummary; error?: string }>(
          `${baseUrl}/health`,
        ),
        fetchJson<{
          ok: boolean;
          gateway: GatewayStatusSummary;
          devices: GatewayRuntimeDeviceSummary[];
          error?: string;
        }>(`${baseUrl}/devices`),
      ]);

      const nextRuntimeState =
        healthPayload.ok && devicesPayload.ok ? "running" : "degraded";

      deps.updateGatewayStatus(
        normalizeGatewayHealth(healthPayload),
        nextRuntimeState,
        healthPayload.error ?? devicesPayload.error ?? deps.getSetupState().adapterIssue,
      );

      const currentSnapshot = deps.getSnapshot();
      const previousIds = new Set(currentSnapshot.devices.map((device) => device.id));
      const nextSnapshot = deps.pruneSnapshot({
        ...currentSnapshot,
        devices: devicesPayload.devices,
      });
      deps.setSnapshot(nextSnapshot);

      await deps.refreshAdapters();

      await refreshManualScanState();

      if (
        previousIds.size !== devicesPayload.devices.length ||
        devicesPayload.devices.some((device) => !previousIds.has(device.id))
      ) {
        await refreshHistory();
        deps.emit({ type: "snapshot", snapshot: deps.getSnapshot() });
        return;
      }

      for (const device of devicesPayload.devices) {
        if (!deps.getSnapshot().devices.some((currentDevice) => currentDevice.id === device.id)) {
          continue;
        }

        deps.emit({ type: "device-upserted", device });
      }
    } catch (error) {
      const snapshot = deps.getSnapshot();
      deps.updateGatewayStatus(
        {
          ...snapshot.gateway,
          updatedAt: new Date().toISOString(),
        },
        "degraded",
        error instanceof Error ? error.message : "Gateway runtime unavailable.",
      );
    }
  }

  return {
    refreshManualScanState,
    refreshHistory,
    refreshGatewayState,
  };
}
