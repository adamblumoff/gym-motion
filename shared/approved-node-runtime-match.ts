import type {
  ApprovedNodeRule,
  DiscoveredNodeSummary,
  GatewayRuntimeDeviceSummary,
} from "./contracts";

export type ApprovedNodeIdentity = {
  peripheralId: string | null;
  address: string | null;
  localName: string | null;
  knownDeviceId: string | null;
};

type ForgetIdentity = ApprovedNodeIdentity & {
  id: string | null;
};

function exactIdentityMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(left && right && left === right);
}

export function addressIdentityMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function nodeRuleId(identity: ApprovedNodeIdentity) {
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

export function canUseUniqueLocalNameFallback(
  approvedNode: ApprovedNodeRule,
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  return Boolean(
    !approvedNode.knownDeviceId &&
      !approvedNode.peripheralId &&
      !approvedNode.address &&
      approvedNode.localName &&
      approvedNodes.filter((rule) => rule.localName === approvedNode.localName).length === 1,
  );
}

export function matchesApprovedNodeIdentity(
  approvedNode: ApprovedNodeRule,
  identity: ApprovedNodeIdentity,
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  return Boolean(
    exactIdentityMatch(approvedNode.knownDeviceId, identity.knownDeviceId) ||
      exactIdentityMatch(approvedNode.peripheralId, identity.peripheralId) ||
      addressIdentityMatch(approvedNode.address, identity.address) ||
      (canUseUniqueLocalNameFallback(approvedNode, approvedNodes) &&
        exactIdentityMatch(approvedNode.localName, identity.localName)),
  );
}

export function findMatchingGatewayDeviceForApprovedNode(
  approvedNode: ApprovedNodeRule,
  devices: GatewayRuntimeDeviceSummary[],
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  const byKnownDeviceId = devices.find((device) =>
    exactIdentityMatch(approvedNode.knownDeviceId, device.id),
  );
  if (byKnownDeviceId) {
    return byKnownDeviceId;
  }

  const byPeripheralId = devices.find((device) =>
    exactIdentityMatch(approvedNode.peripheralId, device.peripheralId),
  );
  if (byPeripheralId) {
    return byPeripheralId;
  }

  const byAddress = approvedNode.address
    ? devices.filter((device) => addressIdentityMatch(approvedNode.address, device.address))
    : [];
  if (byAddress.length === 1) {
    return byAddress[0];
  }

  const byAdvertisedName = canUseUniqueLocalNameFallback(approvedNode, approvedNodes)
    ? devices.filter((device) => device.advertisedName === approvedNode.localName)
    : [];
  if (byAdvertisedName.length === 1) {
    return byAdvertisedName[0];
  }

  return null;
}

export function findMatchingDiscoveredNodeId(
  nodesById: Map<string, DiscoveredNodeSummary>,
  approvedNode: ApprovedNodeRule,
  approvedNodes: ApprovedNodeRule[] = [approvedNode],
) {
  if (nodesById.has(approvedNode.id)) {
    return approvedNode.id;
  }

  const localNameMatches =
    canUseUniqueLocalNameFallback(approvedNode, approvedNodes) && approvedNode.localName
      ? [...nodesById.values()].filter((node) => node.localName === approvedNode.localName)
      : [];

  for (const node of nodesById.values()) {
    if (
      matchesApprovedNodeIdentity(
        approvedNode,
        {
          peripheralId: node.peripheralId ?? null,
          address: node.address ?? null,
          localName: node.localName ?? null,
          knownDeviceId: node.knownDeviceId ?? null,
        },
        approvedNodes,
      )
    ) {
      if (
        approvedNode.localName &&
        !approvedNode.knownDeviceId &&
        !approvedNode.peripheralId &&
        !approvedNode.address &&
        localNameMatches.length !== 1
      ) {
        continue;
      }

      return node.id;
    }
  }

  return null;
}

export function forgetApprovedNodeRules(
  approvedNodes: ApprovedNodeRule[],
  identity: string | ForgetIdentity,
) {
  const forgetIdentity: ForgetIdentity =
    typeof identity === "string"
      ? {
          id: identity,
          knownDeviceId: identity,
          peripheralId: identity,
          address: null,
          localName: null,
        }
      : identity;

  const localNameMatches = approvedNodes.filter((rule) =>
    exactIdentityMatch(rule.localName, forgetIdentity.localName),
  );
  const allowLocalNameFallback = localNameMatches.length === 1;

  return approvedNodes.filter((rule) => {
    const strongIdentityMatch =
      exactIdentityMatch(rule.id, forgetIdentity.id) ||
      exactIdentityMatch(rule.knownDeviceId, forgetIdentity.knownDeviceId) ||
      exactIdentityMatch(rule.peripheralId, forgetIdentity.peripheralId) ||
      addressIdentityMatch(rule.address, forgetIdentity.address);

    if (strongIdentityMatch) {
      return false;
    }

    if (
      allowLocalNameFallback &&
      exactIdentityMatch(rule.localName, forgetIdentity.localName)
    ) {
      return false;
    }

    return true;
  });
}
