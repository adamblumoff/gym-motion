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

function exactIdentityMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(left && right && left === right);
}

function addressIdentityMatch(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function findMatchingGatewayDeviceForApprovedNode(
  approvedNode: ApprovedNodeRule,
  devices: GatewayRuntimeDeviceSummary[],
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

  const byAdvertisedName = approvedNode.localName
    ? devices.filter((device) => device.advertisedName === approvedNode.localName)
    : [];

  if (byAdvertisedName.length === 1) {
    return byAdvertisedName[0];
  }

  return null;
}

export function reconcileApprovedNodeRule(
  approvedNode: ApprovedNodeRule,
  devices: GatewayRuntimeDeviceSummary[],
): ApprovedNodeRule {
  const matchingDevice = findMatchingGatewayDeviceForApprovedNode(approvedNode, devices);

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
