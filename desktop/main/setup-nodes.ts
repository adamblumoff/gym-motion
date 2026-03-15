import type { ApprovedNodeRule, DiscoveredNodeSummary } from "@core/contracts";

export function matchingApprovedSetupNodeId(
  nodesById: Map<string, DiscoveredNodeSummary>,
  approvedNode: ApprovedNodeRule,
) {
  if (nodesById.has(approvedNode.id)) {
    return approvedNode.id;
  }

  for (const node of nodesById.values()) {
    if (
      (approvedNode.knownDeviceId && node.knownDeviceId === approvedNode.knownDeviceId) ||
      (approvedNode.peripheralId && node.peripheralId === approvedNode.peripheralId) ||
      (approvedNode.address && node.address === approvedNode.address)
    ) {
      return node.id;
    }
  }

  return null;
}

export function hasApprovedSetupNode(
  nodesById: Map<string, DiscoveredNodeSummary>,
  approvedNode: ApprovedNodeRule,
) {
  return matchingApprovedSetupNodeId(nodesById, approvedNode) !== null;
}
