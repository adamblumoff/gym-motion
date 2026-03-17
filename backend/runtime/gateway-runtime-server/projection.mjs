import { latestTimestamp } from "./utils.mjs";

export function createProjectionHelpers({
  metadataByDeviceId,
  runtimeByDeviceId,
  knownNodesByDeviceId,
  deviceIdByPeripheralId,
  gatewayState,
  broadcast,
  broadcastGatewayStatus,
  touchGatewayState,
  nowIso,
  healthStatusFromRuntime,
  telemetryFreshnessFromTimestamp,
  emptyOtaRuntimeState,
  emptyReconnectRuntimeState,
}) {
  function mergeDevice(deviceId) {
    const metadata = metadataByDeviceId.get(deviceId);
    const runtime = runtimeByDeviceId.get(deviceId);
    const known = knownNodesByDeviceId.get(deviceId);
    const connectionState =
      runtime?.gatewayConnectionState ??
      (known ? "disconnected" : "unreachable");
    const freshnessTimestamp = latestTimestamp(
      runtime?.gatewayLastTelemetryAt ?? null,
      metadata?.lastHeartbeatAt ?? null,
      metadata?.lastEventReceivedAt ?? null,
    );
    const telemetryFreshness = telemetryFreshnessFromTimestamp(
      freshnessTimestamp,
    );

    return {
      id: deviceId,
      lastState: runtime?.lastState ?? metadata?.lastState ?? "still",
      lastSeenAt: runtime?.lastSeenAt ?? metadata?.lastSeenAt ?? 0,
      lastDelta: runtime?.lastDelta ?? metadata?.lastDelta ?? null,
      updatedAt: runtime?.updatedAt ?? metadata?.updatedAt ?? nowIso(),
      hardwareId: runtime?.hardwareId ?? metadata?.hardwareId ?? known?.hardwareId ?? null,
      bootId: runtime?.bootId ?? metadata?.bootId ?? null,
      firmwareVersion:
        runtime?.firmwareVersion ?? metadata?.firmwareVersion ?? known?.firmwareVersion ?? "unknown",
      machineLabel: metadata?.machineLabel ?? known?.machineLabel ?? null,
      siteId: metadata?.siteId ?? known?.siteId ?? null,
      provisioningState: metadata?.provisioningState ?? "assigned",
      updateStatus: metadata?.updateStatus ?? "idle",
      lastHeartbeatAt: metadata?.lastHeartbeatAt ?? null,
      lastEventReceivedAt: metadata?.lastEventReceivedAt ?? null,
      updateTargetVersion: metadata?.updateTargetVersion ?? null,
      updateDetail: metadata?.updateDetail ?? null,
      updateUpdatedAt: metadata?.updateUpdatedAt ?? null,
      healthStatus: healthStatusFromRuntime(connectionState),
      gatewayConnectionState: connectionState,
      telemetryFreshness,
      peripheralId: runtime?.peripheralId ?? known?.peripheralId ?? null,
      address: runtime?.address ?? known?.lastKnownAddress ?? null,
      gatewayLastAdvertisementAt:
        runtime?.gatewayLastAdvertisementAt ?? known?.lastSeenAt ?? null,
      gatewayLastConnectedAt:
        runtime?.gatewayLastConnectedAt ?? known?.lastConnectedAt ?? null,
      gatewayLastDisconnectedAt: runtime?.gatewayLastDisconnectedAt ?? null,
      gatewayLastTelemetryAt: runtime?.gatewayLastTelemetryAt ?? null,
      gatewayDisconnectReason: runtime?.gatewayDisconnectReason ?? null,
      advertisedName: runtime?.advertisedName ?? known?.lastAdvertisedName ?? null,
      lastRssi: runtime?.lastRssi ?? null,
      otaStatus: runtime?.otaStatus ?? metadata?.updateStatus ?? "idle",
      otaTargetVersion: runtime?.otaTargetVersion ?? metadata?.updateTargetVersion ?? null,
      otaProgressBytesSent: runtime?.otaProgressBytesSent ?? null,
      otaTotalBytes: runtime?.otaTotalBytes ?? null,
      otaLastPhase: runtime?.otaLastPhase ?? null,
      otaFailureDetail: runtime?.otaFailureDetail ?? metadata?.updateDetail ?? null,
      otaLastStatusMessage: runtime?.otaLastStatusMessage ?? null,
      otaUpdatedAt: runtime?.otaUpdatedAt ?? metadata?.updateUpdatedAt ?? null,
      reconnectAttempt: runtime?.reconnectAttempt ?? 0,
      reconnectAttemptLimit: runtime?.reconnectAttemptLimit ?? 20,
      reconnectRetryExhausted: runtime?.reconnectRetryExhausted ?? false,
      reconnectAwaitingDecision: runtime?.reconnectAwaitingDecision ?? false,
      historySyncState: runtime?.historySyncState ?? "idle",
      historySyncError: runtime?.historySyncError ?? null,
      historySyncUpdatedAt: runtime?.historySyncUpdatedAt ?? null,
    };
  }

  function emitDevice(deviceId) {
    if (!deviceId) {
      return;
    }

    const device = mergeDevice(deviceId);
    broadcast("gateway-device", { device });
  }

  function upsertKnownNode(deviceId, patch = {}) {
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

  function resolveKnownDeviceId(peripheralId) {
    if (!peripheralId) {
      return null;
    }

    return deviceIdByPeripheralId.get(peripheralId) ?? null;
  }

  function normalizeBleAddress(address) {
    return typeof address === "string" ? address.toLowerCase() : null;
  }

  function resolveKnownDeviceIdByDiscovery({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    localName,
    address,
  }) {
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

  function updateRuntimeNode(deviceId, patch) {
    if (!deviceId) {
      return;
    }

    const previous = runtimeByDeviceId.get(deviceId) ?? {
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
      lastSeenAt: 0,
      lastDelta: null,
      firmwareVersion: "unknown",
      bootId: null,
      hardwareId: null,
      historySyncState: "idle",
      historySyncError: null,
      historySyncUpdatedAt: null,
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
      if (
        runtime.gatewayConnectionState === "connecting" ||
        runtime.gatewayConnectionState === "reconnecting" ||
        runtime.gatewayConnectionState === "discovered"
      ) {
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
  }) {
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
      peripheralId: merged.peripheralId,
      address: merged.address,
      advertisedName: merged.advertisedName,
      lastTelemetryAt: runtime?.gatewayLastTelemetryAt ?? null,
      lastConnectedAt: runtime?.gatewayLastConnectedAt ?? null,
      lastDisconnectedAt: runtime?.gatewayLastDisconnectedAt ?? null,
      disconnectReason: runtime?.gatewayDisconnectReason ?? null,
      historySyncState: merged.historySyncState ?? "idle",
      historySyncError: merged.historySyncError ?? null,
      historySyncUpdatedAt: merged.historySyncUpdatedAt ?? null,
    };
  }

  return {
    mergeDevice,
    emitDevice,
    upsertKnownNode,
    resolveKnownDeviceIdByDiscovery,
    updateRuntimeNode,
    normalizeIdleConnectionStates,
    inspectNodeConnection,
  };
}
