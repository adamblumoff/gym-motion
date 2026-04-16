import type {
  DiscoveryLocator,
  KnownNode,
  KnownNodeStore,
  RuntimeNode,
  TouchGatewayState,
} from "./runtime-types.js";

export function createRuntimeDeviceAdminEventHandlers({
  runtimeByDeviceId,
  knownNodesByDeviceId,
  suppressedDeviceIds,
  deviceIdByPeripheralId,
  knownNodeStore,
  touchGatewayState,
  broadcastGatewayStatus,
  removeDiscoveryEntries,
  resolveKnownDeviceIdByDiscovery,
  clearPendingReconnectDisconnect,
}: {
  runtimeByDeviceId: Map<string, RuntimeNode>;
  knownNodesByDeviceId: Map<string, KnownNode>;
  suppressedDeviceIds: Set<string>;
  deviceIdByPeripheralId: Map<string, string>;
  knownNodeStore: KnownNodeStore;
  touchGatewayState: TouchGatewayState;
  broadcastGatewayStatus: () => void;
  removeDiscoveryEntries: (
    payload: Required<
      Pick<DiscoveryLocator, "knownDeviceId" | "peripheralId" | "address" | "localName">
    >,
  ) => void;
  resolveKnownDeviceIdByDiscovery: (input: DiscoveryLocator) => string | null;
  clearPendingReconnectDisconnect: (deviceId: string | null | undefined) => unknown;
}) {
  function restoreApprovedDevice({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    localName,
    address,
  }: DiscoveryLocator) {
    const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
      deviceId,
      knownDeviceId,
      peripheralId,
      localName,
      address,
    });

    if (!resolvedDeviceId) {
      return null;
    }

    suppressedDeviceIds.delete(resolvedDeviceId);
    touchGatewayState();
    broadcastGatewayStatus();
    return resolvedDeviceId;
  }

  function forgetDevice({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    localName,
    address,
  }: DiscoveryLocator) {
    const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
      deviceId,
      knownDeviceId,
      peripheralId,
      localName,
      address,
    });

    if (resolvedDeviceId) {
      clearPendingReconnectDisconnect(resolvedDeviceId);
      suppressedDeviceIds.add(resolvedDeviceId);
      runtimeByDeviceId.delete(resolvedDeviceId);
      knownNodesByDeviceId.delete(resolvedDeviceId);
    }

    if (peripheralId) {
      deviceIdByPeripheralId.delete(peripheralId);
    }

    removeDiscoveryEntries({
      knownDeviceId: resolvedDeviceId ?? knownDeviceId ?? null,
      peripheralId: peripheralId ?? null,
      address: address ?? null,
      localName: localName ?? null,
    });

    knownNodeStore.schedulePersist();
    touchGatewayState();
    broadcastGatewayStatus();

    return resolvedDeviceId;
  }

  return {
    restoreApprovedDevice,
    forgetDevice,
  };
}
