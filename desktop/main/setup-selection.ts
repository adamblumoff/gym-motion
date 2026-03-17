import type {
  ApprovedNodeRule,
  DiscoveredNodeSummary,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";
import {
  findMatchingGatewayDeviceForApprovedNode,
  matchesApprovedNodeIdentity,
  nodeRuleId,
  type ApprovedNodeIdentity,
} from "@core/approved-node-runtime-match";

export {
  findMatchingGatewayDeviceForApprovedNode,
  forgetApprovedNodeRules,
  nodeRuleId,
} from "@core/approved-node-runtime-match";

type DiscoveryIdentity = ApprovedNodeIdentity;

export function createApprovedNodeRule(
  node: Pick<
    DiscoveredNodeSummary,
    "label" | "peripheralId" | "address" | "localName" | "knownDeviceId"
  >,
): ApprovedNodeRule {
  return {
    id: nodeRuleId(node),
    label: node.label,
    peripheralId: node.peripheralId,
    address: node.address,
    localName: node.localName,
    knownDeviceId: node.knownDeviceId,
  };
}

export function matchesApprovedNodeRule(
  rule: ApprovedNodeRule,
  identity: DiscoveryIdentity,
  approvedNodes: ApprovedNodeRule[] = [rule],
) {
  return matchesApprovedNodeIdentity(rule, identity, approvedNodes);
}

export function reconcileApprovedNodeRule(
  approvedNode: ApprovedNodeRule,
  devices: GatewayRuntimeDeviceSummary[],
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
): ApprovedNodeRule {
  const matchingDevice = findMatchingGatewayDeviceForApprovedNode(
    approvedNode,
    devices,
    approvedNodes,
  );

  if (!matchingDevice) {
    return approvedNode;
  }

  const nextKnownDeviceId = matchingDevice.id;
  const nextPeripheralId = matchingDevice.peripheralId ?? approvedNode.peripheralId;
  const nextAddress = matchingDevice.address ?? approvedNode.address;
  const nextLocalName = matchingDevice.advertisedName ?? approvedNode.localName;

  return {
    id: nodeRuleId({
      knownDeviceId: nextKnownDeviceId,
      peripheralId: nextPeripheralId,
      address: nextAddress,
      localName: nextLocalName,
    }),
    label: matchingDevice.machineLabel ?? approvedNode.label,
    peripheralId: nextPeripheralId,
    address: nextAddress,
    localName: nextLocalName,
    knownDeviceId: nextKnownDeviceId,
  };
}

export function createNodeIdentity(
  node:
    | Pick<
        DiscoveredNodeSummary,
        "peripheralId" | "address" | "localName" | "knownDeviceId"
      >
    | Pick<
        GatewayRuntimeDeviceSummary,
        "peripheralId" | "advertisedName"
      > & { knownDeviceId?: string | null; address?: string | null },
): DiscoveryIdentity {
  return {
    peripheralId: node.peripheralId ?? null,
    address: "address" in node ? node.address ?? null : null,
    localName:
      "localName" in node
        ? node.localName ?? null
        : "advertisedName" in node
          ? node.advertisedName ?? null
          : null,
    knownDeviceId: "knownDeviceId" in node ? node.knownDeviceId ?? null : null,
  };
}
