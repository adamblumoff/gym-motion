import type { DesktopSnapshot, GatewayRuntimeDeviceSummary } from "@core/contracts";

function cloneSnapshot(snapshot: DesktopSnapshot): DesktopSnapshot {
  return {
    ...snapshot,
    gateway: { ...snapshot.gateway },
    devices: [...snapshot.devices],
    events: [...snapshot.events],
    logs: [...snapshot.logs],
    activities: [...snapshot.activities],
  };
}

function sortDevices(devices: GatewayRuntimeDeviceSummary[]) {
  devices.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id),
  );
}

export function createRuntimeCacheSnapshotStore(initialSnapshot: DesktopSnapshot) {
  let snapshot = cloneSnapshot(initialSnapshot);

  function replaceSnapshot(nextSnapshot: DesktopSnapshot) {
    snapshot = cloneSnapshot(nextSnapshot);
  }

  function getSnapshot() {
    return cloneSnapshot(snapshot);
  }

  function getMutableSnapshot() {
    return snapshot;
  }

  function updateGateway(
    gateway: DesktopSnapshot["gateway"],
    runtimeState: DesktopSnapshot["runtimeState"],
    gatewayIssue: string | null,
    liveStatus: string,
  ) {
    snapshot.gateway = { ...gateway };
    snapshot.runtimeState = runtimeState;
    snapshot.gatewayIssue = gatewayIssue;
    snapshot.liveStatus = liveStatus;
  }

  function upsertDevice(device: GatewayRuntimeDeviceSummary) {
    const existingIndex = snapshot.devices.findIndex((item) => item.id === device.id);
    if (existingIndex >= 0) {
      snapshot.devices[existingIndex] = device;
    } else {
      snapshot.devices.push(device);
    }
    sortDevices(snapshot.devices);
  }

  function getDevice(deviceId: string) {
    return snapshot.devices.find((device) => device.id === deviceId) ?? null;
  }

  return {
    replaceSnapshot,
    getSnapshot,
    getMutableSnapshot,
    updateGateway,
    upsertDevice,
    getDevice,
  };
}
