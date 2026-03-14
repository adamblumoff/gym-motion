import type {
  ApprovedNodeRule,
  DiscoveredNodeSummary,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";

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
      (rule.address && identity.address === rule.address) ||
      (rule.localName && identity.localName === rule.localName),
  );
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
