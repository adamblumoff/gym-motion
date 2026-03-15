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
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  if (nodesById.has(approvedNode.id)) {
    return approvedNode.id;
  }

  const localNameMatches =
    !approvedNode.knownDeviceId &&
    !approvedNode.peripheralId &&
    !approvedNode.address &&
    approvedNode.localName
      ? [...nodesById.values()].filter((node) => node.localName === approvedNode.localName)
      : [];
  const localNameRuleMatches =
    !approvedNode.knownDeviceId &&
    !approvedNode.peripheralId &&
    !approvedNode.address &&
    approvedNode.localName
      ? approvedNodes.filter((node) => node.localName === approvedNode.localName)
      : [];

  for (const node of nodesById.values()) {
    if (
      (approvedNode.knownDeviceId && node.knownDeviceId === approvedNode.knownDeviceId) ||
      (approvedNode.peripheralId && node.peripheralId === approvedNode.peripheralId) ||
      addressIdentityMatch(approvedNode.address, node.address) ||
      (!approvedNode.knownDeviceId &&
        !approvedNode.peripheralId &&
        !approvedNode.address &&
        approvedNode.localName &&
        localNameRuleMatches.length === 1 &&
        localNameMatches.length === 1 &&
        node.localName === approvedNode.localName)
    ) {
      return node.id;
    }
  }

  return null;
}

export function hasApprovedSetupNode(
  nodesById: Map<string, DiscoveredNodeSummary>,
  approvedNode: ApprovedNodeRule,
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  return matchingApprovedSetupNodeId(nodesById, approvedNode, approvedNodes) !== null;
}
