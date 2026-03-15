import type { ApprovedNodeRule, DiscoveredNodeSummary } from "@core/contracts";

function addressIdentityMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

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
      addressIdentityMatch(approvedNode.address, node.address)
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
