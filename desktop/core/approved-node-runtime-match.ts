import type { ApprovedNodeRule, GatewayRuntimeDeviceSummary } from "@core/contracts";

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

  const canUseLocalNameFallback =
    !approvedNode.knownDeviceId &&
    !approvedNode.peripheralId &&
    !approvedNode.address &&
    Boolean(approvedNode.localName);
  const byAdvertisedName = canUseLocalNameFallback
    ? devices.filter((device) => device.advertisedName === approvedNode.localName)
    : [];

  if (byAdvertisedName.length === 1) {
    return byAdvertisedName[0];
  }

  return null;
}
