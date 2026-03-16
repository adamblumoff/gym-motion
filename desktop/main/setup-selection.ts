import type {
  ApprovedNodeRule,
  DiscoveredNodeSummary,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";
import { findMatchingGatewayDeviceForApprovedNode } from "@core/approved-node-runtime-match";

export { findMatchingGatewayDeviceForApprovedNode } from "@core/approved-node-runtime-match";

type DiscoveryIdentity = {
  peripheralId: string | null;
  address: string | null;
  localName: string | null;
  knownDeviceId: string | null;
};

export function nodeRuleId(identity: DiscoveryIdentity) {
  if (identity.knownDeviceId) {
    return `known:${identity.knownDeviceId}`;
  }

  if (identity.peripheralId) {
    return `peripheral:${identity.peripheralId}`;
  }

  if (identity.address) {
    return `address:${identity.address}`;
  }

  if (identity.localName) {
    return `name:${identity.localName}`;
  }

  return "unknown";
}

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
) {
  return Boolean(
    (rule.knownDeviceId && identity.knownDeviceId === rule.knownDeviceId) ||
      (rule.peripheralId && identity.peripheralId === rule.peripheralId) ||
      addressIdentityMatch(rule.address, identity.address) ||
      (rule.localName && identity.localName === rule.localName),
  );
}

function addressIdentityMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function reconcileApprovedNodeRule(
  approvedNode: ApprovedNodeRule,
  devices: GatewayRuntimeDeviceSummary[],
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
): ApprovedNodeRule {
  const localNameRuleMatches =
    !approvedNode.knownDeviceId &&
    !approvedNode.peripheralId &&
    !approvedNode.address &&
    approvedNode.localName
      ? approvedNodes.filter((node) => node.localName === approvedNode.localName)
      : [];
  const canUseLocalNameFallback = localNameRuleMatches.length === 1;

  const matchingDevice = findMatchingGatewayDeviceForApprovedNode(approvedNode, devices);
  if (
    matchingDevice &&
    approvedNode.localName &&
    !approvedNode.knownDeviceId &&
    !approvedNode.peripheralId &&
    !approvedNode.address &&
    !canUseLocalNameFallback &&
    matchingDevice.advertisedName === approvedNode.localName
  ) {
    return approvedNode;
  }

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
