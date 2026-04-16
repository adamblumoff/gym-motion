import type { ApprovedNodeRule, DesktopSnapshot, GatewayRuntimeDeviceSummary } from "@core/contracts";

import { matchesApprovedNodeRule } from "../setup-selection";

function deviceMatchesApprovedNode(
  device: GatewayRuntimeDeviceSummary,
  approvedNodes: ApprovedNodeRule[],
) {
  return approvedNodes.some((approvedNode) =>
    matchesApprovedNodeRule(
      approvedNode,
      {
        knownDeviceId: device.id,
        peripheralId: device.peripheralId,
        address: device.address ?? null,
        localName: device.advertisedName ?? null,
      },
      approvedNodes,
    ),
  );
}

export function applyApprovedNodeFilterToSnapshot(
  snapshot: DesktopSnapshot,
  approvedNodes: ApprovedNodeRule[],
  rebuildActivityIndex: () => void,
) {
  const nextDevices = snapshot.devices.filter((device) =>
    deviceMatchesApprovedNode(device, approvedNodes),
  );
  if (nextDevices.length === snapshot.devices.length) {
    return false;
  }

  const remainingDeviceIds = new Set(nextDevices.map((device) => device.id));
  snapshot.devices = nextDevices;
  snapshot.events = snapshot.events.filter((event) => remainingDeviceIds.has(event.deviceId));
  snapshot.logs = snapshot.logs.filter((log) => remainingDeviceIds.has(log.deviceId));
  snapshot.activities = snapshot.activities.filter((activity) =>
    remainingDeviceIds.has(activity.deviceId),
  );
  snapshot.gateway = {
    ...snapshot.gateway,
    connectedNodeCount: nextDevices.filter(
      (device) => device.gatewayConnectionState === "connected",
    ).length,
    reconnectingNodeCount: nextDevices.filter((device) =>
      ["connecting", "reconnecting"].includes(device.gatewayConnectionState),
    ).length,
    knownNodeCount: nextDevices.length,
    updatedAt: new Date().toISOString(),
  };
  rebuildActivityIndex();
  return true;
}
