import type {
  ApprovedNodeRule,
  DesktopSnapshot,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";

import { matchesApprovedNodeRule } from "../setup-selection";
import { liveStatusFor } from "./snapshot";

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

export function pruneForgottenDevicesFromSnapshot(
  snapshot: DesktopSnapshot,
  approvedNodes: ApprovedNodeRule[],
) {
  const remainingDevices = snapshot.devices.filter((device) =>
    deviceMatchesApprovedNode(device, approvedNodes),
  );

  if (remainingDevices.length === snapshot.devices.length) {
    return snapshot;
  }

  const remainingDeviceIds = new Set(remainingDevices.map((device) => device.id));
  const nextSnapshot: DesktopSnapshot = {
    ...snapshot,
    devices: remainingDevices,
    events: snapshot.events.filter((event) => remainingDeviceIds.has(event.deviceId)),
    logs: snapshot.logs.filter((log) => remainingDeviceIds.has(log.deviceId)),
    activities: snapshot.activities.filter((activity) =>
      remainingDeviceIds.has(activity.deviceId),
    ),
    gateway: {
      ...snapshot.gateway,
      connectedNodeCount: remainingDevices.filter(
        (device) => device.gatewayConnectionState === "connected",
      ).length,
      reconnectingNodeCount: remainingDevices.filter((device) =>
        ["connecting", "reconnecting"].includes(device.gatewayConnectionState),
      ).length,
      knownNodeCount: remainingDevices.length,
      updatedAt: new Date().toISOString(),
    },
  };

  return {
    ...nextSnapshot,
    liveStatus: liveStatusFor(nextSnapshot),
  };
}
