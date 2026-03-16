import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DiscoveredNodeSummary,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";

import { findMatchingGatewayDeviceForApprovedNode } from "../setup-selection";
import { hasApprovedSetupNode, matchingApprovedSetupNodeId } from "../setup-nodes";

export function normalizeApprovedNodes(
  store: { getJson: <T>(key: string) => T | null | undefined },
  key: string,
) {
  const nodes = store.getJson<ApprovedNodeRule[]>(key);

  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.filter((node) => typeof node?.id === "string");
}

export function dedupeApprovedNodes(nodes: ApprovedNodeRule[]) {
  const byId = new Map<string, ApprovedNodeRule>();

  for (const node of nodes) {
    byId.set(node.id, node);
  }

  return [...byId.values()];
}

export function mergeSetupNodes(args: {
  nodes: DiscoveredNodeSummary[];
  approvedNodes: ApprovedNodeRule[];
  devices: GatewayRuntimeDeviceSummary[];
  adapterIssue: string | null;
}) {
  const { nodes, approvedNodes, devices, adapterIssue } = args;
  const byId = new Map<string, DiscoveredNodeSummary>();

  for (const node of nodes) {
    byId.set(node.id, node);
  }

  for (const approvedNode of approvedNodes) {
    const matchingDevice = findMatchingGatewayDeviceForApprovedNode(
      approvedNode,
      devices,
    );

    const alreadyPresent = hasApprovedSetupNode(byId, approvedNode, approvedNodes);

    if (!alreadyPresent) {
      byId.set(approvedNode.id, {
        id: approvedNode.id,
        label:
          matchingDevice?.machineLabel ??
          approvedNode.label ??
          approvedNode.localName ??
          approvedNode.knownDeviceId ??
          approvedNode.peripheralId ??
          "Approved node",
        peripheralId: approvedNode.peripheralId,
        address: approvedNode.address,
        localName: approvedNode.localName,
        knownDeviceId: approvedNode.knownDeviceId ?? matchingDevice?.id ?? null,
        machineLabel: matchingDevice?.machineLabel ?? null,
        siteId: matchingDevice?.siteId ?? null,
        lastRssi: matchingDevice?.lastRssi ?? null,
        lastSeenAt:
          matchingDevice?.gatewayLastAdvertisementAt ??
          matchingDevice?.gatewayLastTelemetryAt ??
          null,
        gatewayConnectionState: matchingDevice?.gatewayConnectionState ?? "visible",
        isApproved: true,
      });
      continue;
    }

    const matchingNodeId = matchingApprovedSetupNodeId(byId, approvedNode, approvedNodes);
    const matchingNode = matchingNodeId ? byId.get(matchingNodeId) ?? null : null;

    if (!matchingNode || matchingNode.id === approvedNode.id) {
      continue;
    }

    byId.delete(matchingNode.id);
    byId.set(approvedNode.id, {
      ...matchingNode,
      id: approvedNode.id,
      label:
        matchingDevice?.machineLabel ??
        matchingNode.machineLabel ??
        approvedNode.label ??
        matchingNode.label,
      peripheralId: matchingDevice?.peripheralId ?? matchingNode.peripheralId,
      localName: matchingDevice?.advertisedName ?? matchingNode.localName,
      knownDeviceId: approvedNode.knownDeviceId ?? matchingNode.knownDeviceId,
      machineLabel: matchingDevice?.machineLabel ?? matchingNode.machineLabel,
      siteId: matchingDevice?.siteId ?? matchingNode.siteId,
      gatewayConnectionState:
        matchingDevice?.gatewayConnectionState ?? matchingNode.gatewayConnectionState,
      isApproved: true,
    });
  }

  return {
    adapterIssue,
    approvedNodes,
    nodes: [...byId.values()].toSorted((left, right) => {
      const leftSeen = left.lastSeenAt ? new Date(left.lastSeenAt).getTime() : 0;
      const rightSeen = right.lastSeenAt ? new Date(right.lastSeenAt).getTime() : 0;
      return rightSeen - leftSeen;
    }),
  } satisfies DesktopSetupState;
}
