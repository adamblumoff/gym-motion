import type { ApprovedNodeRule, DesktopSetupState } from "@core/contracts";

export function resolveVisibleNodes(setup: DesktopSetupState) {
  return setup.nodes.length > 0
    ? setup.nodes
    : setup.approvedNodes.map((node) => ({
        id: node.id,
        label: node.label,
        peripheralId: node.peripheralId,
        address: node.address,
        localName: node.localName,
        knownDeviceId: node.knownDeviceId,
        machineLabel: null,
        siteId: null,
        lastRssi: null,
        lastSeenAt: null,
        gatewayConnectionState: "visible" as const,
        isApproved: true,
      }));
}

export function buildApprovedNodeRules(
  setup: DesktopSetupState,
  selectedIds: Iterable<string>,
): ApprovedNodeRule[] {
  const visibleNodes = resolveVisibleNodes(setup);
  const existingById = new Map(setup.approvedNodes.map((rule) => [rule.id, rule]));
  const nextRules: ApprovedNodeRule[] = [];

  for (const id of selectedIds) {
    const visibleNode = visibleNodes.find((node) => node.id === id);

    if (visibleNode) {
      nextRules.push({
        id: visibleNode.id,
        label: visibleNode.label,
        peripheralId: visibleNode.peripheralId,
        address: visibleNode.address,
        localName: visibleNode.localName,
        knownDeviceId: visibleNode.knownDeviceId,
      });
      continue;
    }

    const existing = existingById.get(id);
    if (existing) {
      nextRules.push(existing);
    }
  }

  return nextRules;
}
