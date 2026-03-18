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
};

export type RuntimeSync = {
  refreshHistory: () => Promise<void>;
};

async function loadSnapshotHistory(snapshot: DesktopSnapshot) {
  const [repositoryDevices, events, logs] = await Promise.all([
    listDevices(),
    listRecentEvents(14),
    listDeviceLogs({ limit: 18 }),
  ]);
  const activityGroups = await Promise.all(
    repositoryDevices.map((device) => listDeviceActivity({ deviceId: device.id, limit: 12 })),
  );
  const activities = activityGroups
    .flat()
    .toSorted(
      (left, right) =>
        new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime(),
    )
    .slice(0, 30);

  let devices = snapshot.devices;

  for (const device of repositoryDevices) {
    devices = mergeGatewayDeviceUpdate(
      devices,
      mergeRepositoryDeviceIntoGatewaySnapshot(devices, device),
    );
  }

  return {
    devices,
    events,
    logs,
    activities,
  };
}

export function createRuntimeSync(deps: RuntimeSyncDeps): RuntimeSync {
  async function refreshHistory() {
    const snapshot = deps.getSnapshot();
    const history = await loadSnapshotHistory(snapshot);

    deps.setSnapshot({
      ...snapshot,
      ...history,
    });
  }

  return {
    refreshHistory,
  };
}
