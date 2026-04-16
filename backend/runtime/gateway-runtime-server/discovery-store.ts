import type { ManualScanCandidateSummary } from "@core/contracts";
import type { DiscoveryUpsertPayload } from "./runtime-types.js";

type DiscoveryEntry = ManualScanCandidateSummary;

function normalizeBleAddress(address: string | null | undefined) {
  return typeof address === "string" ? address.toLowerCase() : null;
}

export function createDiscoveryStore({ nowIso }: { nowIso: () => string }) {
  const discoveriesById = new Map<string, DiscoveryEntry>();

  function discoveryIdFor({ peripheralId, address, localName, knownDeviceId }: DiscoveryUpsertPayload) {
    if (knownDeviceId) {
      return `known:${knownDeviceId}`;
    }

    if (peripheralId) {
      return `peripheral:${peripheralId}`;
    }

    if (address) {
      return `address:${address}`;
    }

    if (localName) {
      return `name:${localName}`;
    }

    return "unknown";
  }

  function upsertDiscovery({
    peripheralId,
    address,
    localName,
    rssi,
    knownDeviceId = null,
  }: DiscoveryUpsertPayload) {
    const id = discoveryIdFor({ peripheralId, address, localName, knownDeviceId });
    const aliasIds = new Set<string>();

    if (knownDeviceId) {
      aliasIds.add(`known:${knownDeviceId}`);
    }

    if (peripheralId) {
      aliasIds.add(`peripheral:${peripheralId}`);
    }

    if (address) {
      aliasIds.add(`address:${address}`);
    }

    if (localName) {
      aliasIds.add(`name:${localName}`);
    }

    let previous: Partial<DiscoveryEntry> = discoveriesById.get(id) ?? {};

    for (const aliasId of aliasIds) {
      if (aliasId === id) {
        continue;
      }

      const aliasEntry = discoveriesById.get(aliasId);

      if (!aliasEntry) {
        continue;
      }

      previous = {
        ...aliasEntry,
        ...previous,
      };
      discoveriesById.delete(aliasId);
    }

    const next: DiscoveryEntry = {
      ...previous,
      id,
      label:
        previous.label ??
        localName ??
        peripheralId ??
        address ??
        knownDeviceId ??
        id,
      peripheralId: peripheralId ?? previous.peripheralId ?? null,
      address: address ?? previous.address ?? null,
      localName: localName ?? previous.localName ?? null,
      knownDeviceId,
      machineLabel: previous.machineLabel ?? null,
      siteId: previous.siteId ?? null,
      lastSeenAt: nowIso(),
      lastRssi: rssi ?? previous.lastRssi ?? null,
    };

    discoveriesById.set(id, next);
    return next;
  }

  function removeDiscoveryEntries({
    knownDeviceId = null,
    peripheralId = null,
    address = null,
    localName = null,
  }: {
    knownDeviceId?: string | null;
    peripheralId?: string | null;
    address?: string | null;
    localName?: string | null;
  }) {
    for (const [id, discovery] of discoveriesById.entries()) {
      if (
        (knownDeviceId && discovery.knownDeviceId === knownDeviceId) ||
        (peripheralId && discovery.peripheralId === peripheralId) ||
        (address && normalizeBleAddress(discovery.address) === normalizeBleAddress(address)) ||
        (localName && discovery.localName === localName)
      ) {
        discoveriesById.delete(id);
      }
    }
  }

  function listDiscoveries() {
    return Array.from(discoveriesById.values()).toSorted(
      (left, right) =>
        new Date(right.lastSeenAt ?? 0).getTime() -
        new Date(left.lastSeenAt ?? 0).getTime(),
    );
  }

  return {
    discoveryIdFor,
    listDiscoveries,
    removeDiscoveryEntries,
    upsertDiscovery,
  };
}
