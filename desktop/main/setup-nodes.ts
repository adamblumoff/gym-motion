import type { ApprovedNodeRule, DiscoveredNodeSummary } from "@core/contracts";

export function hasApprovedSetupNode(
  nodesById: Map<string, DiscoveredNodeSummary>,
  approvedNode: ApprovedNodeRule,
) {
  return nodesById.has(approvedNode.id);
}
