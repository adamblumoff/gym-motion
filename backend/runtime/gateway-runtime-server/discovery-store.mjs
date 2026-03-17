function normalizeBleAddress(address) {
  return typeof address === "string" ? address.toLowerCase() : null;
}

export function createDiscoveryStore({ nowIso }) {
  const discoveriesById = new Map();

  function discoveryIdFor({ peripheralId, address, localName, knownDeviceId }) {
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

  function upsertDiscovery({ peripheralId, address, localName, rssi, knownDeviceId = null }) {
    const id = discoveryIdFor({ peripheralId, address, localName, knownDeviceId });
    const aliasIds = new Set();

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

    let previous = discoveriesById.get(id) ?? {};

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

    const next = {
      ...previous,
      id,
      peripheralId: peripheralId ?? previous.peripheralId ?? null,
      address: address ?? previous.address ?? null,
      localName: localName ?? previous.localName ?? null,
      knownDeviceId,
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
