import type { GatewayRuntimeDeviceSummary } from "@core/contracts";
import type {
  EmitDevice,
  KnownNode,
  DiscoveryLocator,
  MergeDevice,
  NodeConnectionInspection,
  RuntimeDeviceMetadata,
  RuntimeNode,
  RuntimeNodePatch,
  OtaRuntimeState,
  ReconnectRuntimeState,
  TouchGatewayState,
} from "./runtime-types.js";

export function createRuntimeStateHelpers({
  metadataByDeviceId,
  runtimeByDeviceId,
  knownNodesByDeviceId,
  deviceIdByPeripheralId,
  touchGatewayState,
  emitDevice,
  mergeDevice,
  emptyOtaRuntimeState,
  emptyReconnectRuntimeState,
  nowIso,
}: {
  metadataByDeviceId: Map<string, RuntimeDeviceMetadata>;
  runtimeByDeviceId: Map<string, RuntimeNode>;
  knownNodesByDeviceId: Map<string, KnownNode>;
  deviceIdByPeripheralId: Map<string, string>;
  touchGatewayState: TouchGatewayState;
  emitDevice: EmitDevice;
  mergeDevice: MergeDevice;
  emptyOtaRuntimeState: () => OtaRuntimeState;
  emptyReconnectRuntimeState: () => ReconnectRuntimeState;
  nowIso: () => string;
}) {
  function upsertKnownNode(deviceId: string | null | undefined, patch: Partial<KnownNode> = {}) {
    if (!deviceId) {
      return;
    }

    const previous = knownNodesByDeviceId.get(deviceId) ?? { deviceId };
    const next = {
      ...previous,
      ...patch,
      deviceId,
    };

    knownNodesByDeviceId.set(deviceId, next);

    if (next.peripheralId) {
      deviceIdByPeripheralId.set(next.peripheralId, deviceId);
    }

    touchGatewayState();
  }

  function resolveKnownDeviceId(peripheralId?: string | null) {
    if (!peripheralId) {
      return null;
    }

    return deviceIdByPeripheralId.get(peripheralId) ?? null;
  }

  function normalizeBleAddress(address?: string | null) {
    return typeof address === "string" ? address.toLowerCase() : null;
  }

  function resolveKnownDeviceIdByDiscovery({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    localName,
    address,
  }: DiscoveryLocator) {
    if (deviceId) {
      return deviceId;
    }

    if (knownDeviceId) {
      return knownDeviceId;
    }

    const directMatch = resolveKnownDeviceId(peripheralId);

    if (directMatch) {
      return directMatch;
    }

    if (localName) {
      const nameMatches = Array.from(knownNodesByDeviceId.values()).filter(
        (node) => node.lastAdvertisedName === localName,
      );

      if (nameMatches.length === 1) {
        return nameMatches[0].deviceId;
      }
    }

    if (address) {
      const normalizedAddress = normalizeBleAddress(address);
      const addressMatches = Array.from(knownNodesByDeviceId.values()).filter(
        (node) => normalizeBleAddress(node.lastKnownAddress) === normalizedAddress,
      );

      if (addressMatches.length === 1) {
        return addressMatches[0].deviceId;
      }
    }

    return null;
  }

  function updateRuntimeNode(deviceId: string | null | undefined, patch: RuntimeNodePatch) {
    if (!deviceId) {
      return;
    }

    const previous: RuntimeNode = runtimeByDeviceId.get(deviceId) ?? {
      gatewayConnectionState: "discovered",
      peripheralId: patch.peripheralId ?? null,
      address: patch.address ?? null,
      gatewayLastAdvertisementAt: null,
      gatewayLastConnectedAt: null,
      gatewayLastDisconnectedAt: null,
      gatewayLastTelemetryAt: null,
      gatewayDisconnectReason: null,
      advertisedName: null,
      lastRssi: null,
      lastState: "still",
      sensorIssue: null,
      lastSeenAt: 0,
      lastDelta: null,
      firmwareVersion: "unknown",
      bootId: null,
      hardwareId: null,
      ...emptyOtaRuntimeState(),
      ...emptyReconnectRuntimeState(),
      updatedAt: nowIso(),
    };
    const next = {
      ...previous,
      ...patch,
      updatedAt: nowIso(),
    };

    runtimeByDeviceId.set(deviceId, next);
    touchGatewayState();
  }

  function normalizeIdleConnectionStates() {
    for (const [deviceId, runtime] of runtimeByDeviceId.entries()) {
      if (runtime.gatewayConnectionState === "discovered") {
        runtimeByDeviceId.set(deviceId, {
          ...runtime,
          gatewayConnectionState: "disconnected",
          updatedAt: nowIso(),
        });
        emitDevice(deviceId);
      }
    }
  }

  function inspectNodeConnection({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    localName,
    address,
  }: DiscoveryLocator): NodeConnectionInspection | null {
    const resolvedDeviceId =
      deviceId ??
      resolveKnownDeviceIdByDiscovery({ knownDeviceId, peripheralId, localName, address });

    if (!resolvedDeviceId) {
      return null;
    }

    const runtime = runtimeByDeviceId.get(resolvedDeviceId) ?? null;
    const merged = mergeDevice(resolvedDeviceId);
    return {
      deviceId: resolvedDeviceId,
      gatewayConnectionState: merged.gatewayConnectionState,
      telemetryFreshness: merged.telemetryFreshness,
      lastTelemetryAt: runtime?.gatewayLastTelemetryAt ?? null,
      lastConnectedAt: runtime?.gatewayLastConnectedAt ?? null,
      lastDisconnectedAt: runtime?.gatewayLastDisconnectedAt ?? null,
      disconnectReason: runtime?.gatewayDisconnectReason ?? null,
    };
  }

  function getDeviceSummary(deviceId: string | null | undefined): GatewayRuntimeDeviceSummary | null {
    if (
      !deviceId ||
      (!runtimeByDeviceId.has(deviceId) &&
        !knownNodesByDeviceId.has(deviceId) &&
        !metadataByDeviceId.has(deviceId))
    ) {
      return null;
    }

    return mergeDevice(deviceId);
  }

  function getDeviceSummaries(): GatewayRuntimeDeviceSummary[] {
    const deviceIds = new Set([
      ...knownNodesByDeviceId.keys(),
      ...runtimeByDeviceId.keys(),
      ...metadataByDeviceId.keys(),
    ]);

    return Array.from(deviceIds).map((deviceId) => mergeDevice(deviceId));
  }

  return {
    upsertKnownNode,
    resolveKnownDeviceIdByDiscovery,
    updateRuntimeNode,
    normalizeIdleConnectionStates,
    inspectNodeConnection,
    getDeviceSummary,
    getDeviceSummaries,
  };
}
