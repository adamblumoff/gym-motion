import type { ApprovedNodeRule, DiscoveredNodeSummary } from "@core/contracts";
import { findMatchingDiscoveredNodeId } from "@core/approved-node-runtime-match";

export function matchingApprovedSetupNodeId(
  nodesById: Map<string, DiscoveredNodeSummary>,
  approvedNode: ApprovedNodeRule,
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  return findMatchingDiscoveredNodeId(nodesById, approvedNode, approvedNodes);
}

export function hasApprovedSetupNode(
  nodesById: Map<string, DiscoveredNodeSummary>,
  approvedNode: ApprovedNodeRule,
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  return matchingApprovedSetupNodeId(nodesById, approvedNode, approvedNodes) !== null;
}
