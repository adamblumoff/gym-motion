import type { DesktopSnapshot, DeviceActivitySummary } from "@core/contracts";

import {
  listDeviceActivity,
  listDeviceLogs,
  listDevices,
  listRecentActivity,
  listRecentEvents,
} from "../../../backend/data";
import { mergeGatewayDeviceUpdate } from "@core/contracts";
import { mergeRepositoryDeviceIntoGatewaySnapshot } from "../gateway-snapshot";

type RuntimeSyncDeps = {
  getSnapshot: () => DesktopSnapshot;
  setSnapshot: (snapshot: DesktopSnapshot) => void;
  listDevices?: typeof listDevices;
  listRecentEvents?: typeof listRecentEvents;
  listDeviceLogs?: typeof listDeviceLogs;
  listDeviceActivity?: typeof listDeviceActivity;
  listRecentActivity?: typeof listRecentActivity;
};

export type RuntimeSync = {
  refreshHistory: () => Promise<void>;
  getDeviceActivity: (deviceId: string, limit?: number) => Promise<DeviceActivitySummary[]>;
};

async function loadSnapshotHistory(deps: RuntimeSyncDeps) {
  const loadDevices = deps.listDevices ?? listDevices;
  const loadRecentEvents = deps.listRecentEvents ?? listRecentEvents;
  const loadDeviceLogs = deps.listDeviceLogs ?? listDeviceLogs;
  const loadRecentDeviceActivity = deps.listRecentActivity ?? listRecentActivity;
  const [repositoryDevices, events, logs, activities] = await Promise.all([
    loadDevices(),
    loadRecentEvents(14),
    loadDeviceLogs({ limit: 18 }),
    loadRecentDeviceActivity(30),
  ]);

  return {
    repositoryDevices,
    events,
    logs,
    activities,
  };
}

export function createRuntimeSync(deps: RuntimeSyncDeps): RuntimeSync {
  const loadDeviceActivity = deps.listDeviceActivity ?? listDeviceActivity;

  async function refreshHistory() {
    const history = await loadSnapshotHistory(deps);
    const snapshot = deps.getSnapshot();
    let devices = snapshot.devices;

    for (const device of history.repositoryDevices) {
      devices = mergeGatewayDeviceUpdate(
        devices,
        mergeRepositoryDeviceIntoGatewaySnapshot(devices, device),
      );
    }

    deps.setSnapshot({
      ...snapshot,
      devices,
      events: history.events,
      logs: history.logs,
      activities: history.activities,
    });
  }

  return {
    refreshHistory,
    async getDeviceActivity(deviceId, limit) {
      return loadDeviceActivity({ deviceId, limit });
    },
  };
}
