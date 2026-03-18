import type { DesktopSnapshot } from "@core/contracts";

import {
  listDeviceActivity,
  listDeviceLogs,
  listDevices,
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
};

export type RuntimeSync = {
  refreshHistory: () => Promise<void>;
};

async function loadSnapshotHistory(deps: RuntimeSyncDeps) {
  const loadDevices = deps.listDevices ?? listDevices;
  const loadRecentEvents = deps.listRecentEvents ?? listRecentEvents;
  const loadDeviceLogs = deps.listDeviceLogs ?? listDeviceLogs;
  const loadDeviceActivity = deps.listDeviceActivity ?? listDeviceActivity;
  const [repositoryDevices, events, logs] = await Promise.all([
    loadDevices(),
    loadRecentEvents(14),
    loadDeviceLogs({ limit: 18 }),
  ]);
  const activityGroups = await Promise.all(
    repositoryDevices.map((device) =>
      loadDeviceActivity({ deviceId: device.id, limit: 12 }),
    ),
  );
  const activities = activityGroups
    .flat()
    .toSorted(
      (left, right) =>
        new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime(),
    )
    .slice(0, 30);

  return {
    repositoryDevices,
    events,
    logs,
    activities,
  };
}

export function createRuntimeSync(deps: RuntimeSyncDeps): RuntimeSync {
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
  };
}
