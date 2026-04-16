import type { DesktopSnapshot, DeviceActivitySummary } from "@core/contracts";

import {
  getDevice,
  listDeviceActivity,
  listDeviceLogs,
  listDeviceRecentEvents,
  listDevices,
  listRecentActivity,
  listRecentEvents,
} from "../../../backend/data";
import {
  mergeActivityUpdate,
  mergeEventUpdate,
  mergeLogUpdate,
} from "@core/contracts";
import { applyRepositoryDeviceToGatewaySnapshot } from "../gateway-snapshot";

type RuntimeSyncDeps = {
  getSnapshot: () => DesktopSnapshot;
  setSnapshot: (snapshot: DesktopSnapshot) => void;
  getDevice?: typeof getDevice;
  listDevices?: typeof listDevices;
  listRecentEvents?: typeof listRecentEvents;
  listDeviceRecentEvents?: typeof listDeviceRecentEvents;
  listDeviceLogs?: typeof listDeviceLogs;
  listDeviceActivity?: typeof listDeviceActivity;
  listRecentActivity?: typeof listRecentActivity;
};

export type RuntimeSync = {
  refreshSnapshotData: () => Promise<void>;
  refreshDeviceData: (deviceId: string) => Promise<void>;
  getDeviceActivity: (deviceId: string, limit?: number) => Promise<DeviceActivitySummary[]>;
};

async function loadSnapshotData(deps: RuntimeSyncDeps) {
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
  const loadDevice = deps.getDevice ?? getDevice;
  const loadDeviceActivity = deps.listDeviceActivity ?? listDeviceActivity;
  const loadDeviceRecentEvents = deps.listDeviceRecentEvents ?? listDeviceRecentEvents;
  const loadDeviceLogs = deps.listDeviceLogs ?? listDeviceLogs;

  async function refreshSnapshotData() {
    const snapshotData = await loadSnapshotData(deps);
    const snapshot = deps.getSnapshot();
    let devices = snapshot.devices;

    for (const device of snapshotData.repositoryDevices) {
      devices = applyRepositoryDeviceToGatewaySnapshot(devices, device).devices;
    }

    deps.setSnapshot({
      ...snapshot,
      devices,
      events: snapshotData.events,
      logs: snapshotData.logs,
      activities: snapshotData.activities,
    });
  }

  async function refreshDeviceData(deviceId: string) {
    const [repositoryDevice, deviceEvents, deviceLogs, deviceActivities] = await Promise.all([
      loadDevice(deviceId),
      loadDeviceRecentEvents({ deviceId, limit: 14 }),
      loadDeviceLogs({ deviceId, limit: 18 }),
      loadDeviceActivity({ deviceId, limit: 30 }),
    ]);
    const snapshot = deps.getSnapshot();
    let devices = snapshot.devices;

    if (repositoryDevice) {
      devices = applyRepositoryDeviceToGatewaySnapshot(devices, repositoryDevice).devices;
    }

    let events = snapshot.events.filter((event) => event.deviceId !== deviceId);
    for (const event of deviceEvents.toReversed()) {
      events = mergeEventUpdate(events, event, 14);
    }

    let logs = snapshot.logs.filter((log) => log.deviceId !== deviceId);
    for (const log of deviceLogs.toReversed()) {
      logs = mergeLogUpdate(logs, log, 18);
    }

    let activities = snapshot.activities.filter((activity) => activity.deviceId !== deviceId);
    for (const activity of deviceActivities.toReversed()) {
      activities = mergeActivityUpdate(activities, activity, 30);
    }

    deps.setSnapshot({
      ...snapshot,
      devices,
      events,
      logs,
      activities,
    });
  }

  return {
    refreshSnapshotData,
    refreshDeviceData,
    async getDeviceActivity(deviceId, limit) {
      return loadDeviceActivity({ deviceId, limit });
    },
  };
}
