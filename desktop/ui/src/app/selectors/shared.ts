import type {
  ApprovedNodeRule,
  DeviceActivitySummary,
  DiscoveredNodeSummary,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";
import { matchesApprovedNodeIdentity } from "@core/approved-node-runtime-match";

import type { NodeLog } from "./types";

export function rssiToPercent(rssi: number | null) {
  if (rssi === null) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(((rssi + 100) / 45) * 100)));
}

export function displayNodeName(device: GatewayRuntimeDeviceSummary) {
  return device.machineLabel ?? device.siteId ?? device.advertisedName ?? device.id;
}

export function displayNodeAddress(device: GatewayRuntimeDeviceSummary) {
  return device.address ?? device.peripheralId ?? device.id;
}

export function displayDiscoveryName(
  node: Pick<
    DiscoveredNodeSummary,
    "machineLabel" | "localName" | "knownDeviceId" | "label" | "id"
  >,
) {
  return node.machineLabel ?? node.localName ?? node.knownDeviceId ?? node.label ?? node.id;
}

export function displayDiscoveryAddress(
  node: Pick<DiscoveredNodeSummary, "address" | "peripheralId" | "knownDeviceId" | "id">,
) {
  return node.address ?? node.peripheralId ?? node.knownDeviceId ?? node.id;
}

export function buildNodeLogs(
  device: GatewayRuntimeDeviceSummary,
  activities: DeviceActivitySummary[],
): NodeLog[] {
  return activities
    .filter((activity) => activity.deviceId === device.id)
    .slice(0, 15)
    .map((activity) => ({
      id: activity.id,
      timestamp: new Date(activity.receivedAt),
      message: activity.message,
      isMoving: activity.state === "moving",
    }));
}

export function indexNodeLogs(
  activities: DeviceActivitySummary[],
  limit = 15,
): Map<string, NodeLog[]> {
  const logsByDeviceId = new Map<string, NodeLog[]>();

  for (const activity of activities) {
    const existing = logsByDeviceId.get(activity.deviceId) ?? [];
    if (existing.length >= limit) {
      continue;
    }

    existing.push({
      id: activity.id,
      timestamp: new Date(activity.receivedAt),
      message: activity.message,
      isMoving: activity.state === "moving",
    });
    logsByDeviceId.set(activity.deviceId, existing);
  }

  return logsByDeviceId;
}

export function shouldDisplayDashboardDevice(
  device: GatewayRuntimeDeviceSummary,
  approvedNodes?: ApprovedNodeRule[],
) {
  if (approvedNodes === undefined) {
    return true;
  }

  return approvedNodes.some((approvedNode) =>
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
  );
}
