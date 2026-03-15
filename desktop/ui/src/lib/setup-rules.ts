import type { ApprovedNodeRule, DesktopSetupState } from "@core/contracts";

type DiscoveryIdentity = {
  peripheralId: string | null;
  address: string | null;
  localName: string | null;
  knownDeviceId: string | null;
};

type ForgetIdentity = DiscoveryIdentity & {
  id: string | null;
};

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

function forgetFieldMatches(
  ruleValue: string | null | undefined,
  identityValue: string | null | undefined,
  matcher: (left: string | null | undefined, right: string | null | undefined) => boolean,
) {
  return Boolean(ruleValue && identityValue && matcher(ruleValue, identityValue));
}

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

  return approvedNodes.filter(
    (rule) =>
      !(
        forgetFieldMatches(rule.id, forgetIdentity.id, exactIdentityMatch) ||
        forgetFieldMatches(
          rule.knownDeviceId,
          forgetIdentity.knownDeviceId,
          exactIdentityMatch,
        ) ||
        forgetFieldMatches(
          rule.peripheralId,
          forgetIdentity.peripheralId,
          exactIdentityMatch,
        ) ||
        forgetFieldMatches(rule.address, forgetIdentity.address, addressIdentityMatch) ||
        forgetFieldMatches(rule.localName, forgetIdentity.localName, exactIdentityMatch)
      ),
  );
}

export function matchesApprovedNodeIdentity(
  rule: ApprovedNodeRule,
  identity: DiscoveryIdentity,
) {
  return Boolean(
    exactIdentityMatch(rule.knownDeviceId, identity.knownDeviceId) ||
      exactIdentityMatch(rule.peripheralId, identity.peripheralId) ||
      addressIdentityMatch(rule.address, identity.address) ||
      exactIdentityMatch(rule.localName, identity.localName),
  );
}
