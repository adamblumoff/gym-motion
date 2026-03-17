export function createRuntimeDeviceEventController({
  metadataByDeviceId,
  runtimeByDeviceId,
  knownNodesByDeviceId,
  suppressedDeviceIds,
  deviceIdByPeripheralId,
  gatewayState,
  knownNodeStore,
  refreshMetadata,
  touchGatewayState,
  broadcastGatewayStatus,
  upsertDiscovery,
  removeDiscoveryEntries,
  emitDevice,
  upsertKnownNode,
  resolveKnownDeviceIdByDiscovery,
  updateRuntimeNode,
  inspectNodeConnection,
  nowIso,
}) {
  return {
    noteDiscovery({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      address,
      localName,
      rssi,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
      reconnectRetryExhausted = null,
      reconnectAwaitingDecision = null,
    }) {
      const timestamp = nowIso();
      touchGatewayState({ lastAdvertisementAt: timestamp });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      upsertDiscovery({
        peripheralId,
        address,
        localName,
        rssi,
        knownDeviceId: resolvedDeviceId,
      });

      if (!resolvedDeviceId) {
        broadcastGatewayStatus();
        return;
      }

      const existingRuntime = runtimeByDeviceId.get(resolvedDeviceId) ?? null;
      const nextConnectionState =
        existingRuntime?.gatewayConnectionState ??
        (gatewayState.adapterState === "poweredOn" ? "discovered" : "unreachable");

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: nextConnectionState,
        gatewayLastAdvertisementAt: timestamp,
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
        reconnectAttempt: reconnectAttempt ?? existingRuntime?.reconnectAttempt ?? 0,
        reconnectAttemptLimit:
          reconnectAttemptLimit ?? existingRuntime?.reconnectAttemptLimit ?? 20,
        reconnectRetryExhausted:
          reconnectRetryExhausted ?? existingRuntime?.reconnectRetryExhausted ?? false,
        reconnectAwaitingDecision:
          reconnectAwaitingDecision ?? existingRuntime?.reconnectAwaitingDecision ?? false,
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();

      upsertKnownNode(resolvedDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
        lastSeenAt: timestamp,
      });
      knownNodeStore.schedulePersist();
    },

    noteConnecting({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      address,
      localName,
      rssi,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
      reconnectRetryExhausted = null,
      reconnectAwaitingDecision = null,
    }) {
      const previous = inspectNodeConnection({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      upsertDiscovery({
        peripheralId,
        address,
        localName,
        rssi,
        knownDeviceId: resolvedDeviceId,
      });

      if (!resolvedDeviceId) {
        return;
      }

      const nextConnectionState =
        previous?.gatewayConnectionState === "disconnected" ||
        previous?.gatewayConnectionState === "unreachable" ||
        previous?.gatewayConnectionState === "reconnecting"
          ? "reconnecting"
          : "connecting";

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: nextConnectionState,
        gatewayLastAdvertisementAt: nowIso(),
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
        reconnectAttempt:
          reconnectAttempt ?? runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttempt ?? 0,
        reconnectAttemptLimit:
          reconnectAttemptLimit ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttemptLimit ??
          20,
        reconnectRetryExhausted: reconnectRetryExhausted ?? false,
        reconnectAwaitingDecision: reconnectAwaitingDecision ?? false,
      });
      upsertKnownNode(resolvedDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
      });
      knownNodeStore.schedulePersist();
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return {
        before: previous,
        after: inspectNodeConnection({ deviceId: resolvedDeviceId }),
      };
    },

    noteConnected({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      address,
      localName,
      rssi,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
      reconnectAwaitingDecision = null,
    }) {
      const previous = inspectNodeConnection({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      upsertDiscovery({
        peripheralId,
        address,
        localName,
        rssi,
        knownDeviceId: resolvedDeviceId,
      });

      if (!resolvedDeviceId) {
        return;
      }

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: "connected",
        gatewayLastConnectedAt: nowIso(),
        gatewayDisconnectReason: null,
        historySyncState: "idle",
        historySyncError: null,
        historySyncUpdatedAt: nowIso(),
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
        reconnectAttempt: reconnectAttempt ?? 0,
        reconnectAttemptLimit:
          reconnectAttemptLimit ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttemptLimit ??
          20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: reconnectAwaitingDecision ?? false,
      });
      upsertKnownNode(resolvedDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
        lastConnectedAt: nowIso(),
      });
      knownNodeStore.schedulePersist();
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return {
        before: previous,
        after: inspectNodeConnection({ deviceId: resolvedDeviceId }),
      };
    },

    async noteTelemetry(payload, peripheralInfo = {}) {
      const previous = inspectNodeConnection({ deviceId: payload.deviceId });
      const telemetryAt = nowIso();

      updateRuntimeNode(payload.deviceId, {
        peripheralId:
          peripheralInfo.peripheralId ??
          runtimeByDeviceId.get(payload.deviceId)?.peripheralId ??
          knownNodesByDeviceId.get(payload.deviceId)?.peripheralId ??
          null,
        address:
          peripheralInfo.address ??
          runtimeByDeviceId.get(payload.deviceId)?.address ??
          knownNodesByDeviceId.get(payload.deviceId)?.lastKnownAddress ??
          null,
        gatewayLastTelemetryAt: telemetryAt,
        gatewayLastAdvertisementAt:
          runtimeByDeviceId.get(payload.deviceId)?.gatewayLastAdvertisementAt ?? telemetryAt,
        advertisedName: peripheralInfo.localName ?? null,
        lastRssi: peripheralInfo.rssi ?? null,
        lastState: payload.state,
        lastSeenAt: payload.timestamp,
        lastDelta: payload.delta ?? null,
        firmwareVersion: payload.firmwareVersion ?? "unknown",
        bootId: payload.bootId ?? null,
        hardwareId: payload.hardwareId ?? null,
      });

      upsertKnownNode(payload.deviceId, {
        deviceId: payload.deviceId,
        hardwareId: payload.hardwareId ?? null,
        peripheralId: peripheralInfo.peripheralId ?? null,
        lastKnownAddress: peripheralInfo.address ?? null,
        lastAdvertisedName: peripheralInfo.localName ?? null,
        lastConnectedAt:
          runtimeByDeviceId.get(payload.deviceId)?.gatewayLastConnectedAt ?? telemetryAt,
        lastSeenAt: telemetryAt,
        machineLabel: metadataByDeviceId.get(payload.deviceId)?.machineLabel ?? null,
        siteId: metadataByDeviceId.get(payload.deviceId)?.siteId ?? null,
        firmwareVersion: payload.firmwareVersion ?? "unknown",
      });
      knownNodeStore.schedulePersist();
      upsertDiscovery({
        peripheralId: peripheralInfo.peripheralId ?? null,
        address: peripheralInfo.address ?? null,
        localName: peripheralInfo.localName ?? null,
        rssi: peripheralInfo.rssi ?? null,
        knownDeviceId: payload.deviceId,
      });

      if (peripheralInfo.peripheralId) {
        deviceIdByPeripheralId.set(peripheralInfo.peripheralId, payload.deviceId);
      }

      await refreshMetadata(!metadataByDeviceId.has(payload.deviceId));
      emitDevice(payload.deviceId);
      broadcastGatewayStatus();
      return {
        before: previous,
        after: inspectNodeConnection({ deviceId: payload.deviceId }),
      };
    },

    noteDisconnected({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      localName,
      address,
      reason,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
      reconnectRetryExhausted = null,
      reconnectAwaitingDecision = null,
    }) {
      const previous = inspectNodeConnection({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });

      if (!resolvedDeviceId) {
        return {
          applied: false,
          before: previous,
          after: null,
        };
      }

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: "disconnected",
        gatewayLastDisconnectedAt: nowIso(),
        gatewayDisconnectReason: reason ?? "ble-disconnected",
        historySyncState: "idle",
        historySyncError: null,
        historySyncUpdatedAt: nowIso(),
        reconnectAttempt:
          reconnectAttempt ?? runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttempt ?? 0,
        reconnectAttemptLimit:
          reconnectAttemptLimit ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttemptLimit ??
          20,
        reconnectRetryExhausted:
          reconnectRetryExhausted ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectRetryExhausted ??
          false,
        reconnectAwaitingDecision:
          reconnectAwaitingDecision ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAwaitingDecision ??
          false,
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return {
        applied: true,
        before: previous,
        after: inspectNodeConnection({ deviceId: resolvedDeviceId }),
      };
    },

    noteHistorySyncState({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      localName,
      address,
      state,
      error = null,
    }) {
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

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId:
          peripheralId ?? runtimeByDeviceId.get(resolvedDeviceId)?.peripheralId ?? null,
        address:
          address ?? runtimeByDeviceId.get(resolvedDeviceId)?.address ?? null,
        advertisedName:
          localName ?? runtimeByDeviceId.get(resolvedDeviceId)?.advertisedName ?? null,
        historySyncState: state,
        historySyncError: state === "failed" ? error ?? "History sync needs a manual retry." : null,
        historySyncUpdatedAt: nowIso(),
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return inspectNodeConnection({ deviceId: resolvedDeviceId });
    },

    clearReconnectDecision({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      localName,
      address,
    }) {
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

      updateRuntimeNode(resolvedDeviceId, {
        reconnectAttempt: 0,
        reconnectAttemptLimit:
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttemptLimit ?? 20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return inspectNodeConnection({ deviceId: resolvedDeviceId });
    },

    restoreApprovedDevice({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      localName,
      address,
    }) {
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
    },

    forgetDevice({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      localName,
      address,
    }) {
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });

      if (resolvedDeviceId) {
        suppressedDeviceIds.add(resolvedDeviceId);
        runtimeByDeviceId.delete(resolvedDeviceId);
        knownNodesByDeviceId.delete(resolvedDeviceId);
      }

      if (peripheralId) {
        deviceIdByPeripheralId.delete(peripheralId);
      }

      removeDiscoveryEntries({
        knownDeviceId: resolvedDeviceId ?? knownDeviceId,
        peripheralId,
        address,
        localName,
      });

      knownNodeStore.schedulePersist();
      touchGatewayState();
      broadcastGatewayStatus();

      return resolvedDeviceId;
    },

    noteOtaStatus(deviceId, patch) {
      if (!deviceId) {
        return;
      }

      const previous = runtimeByDeviceId.get(deviceId) ?? {};

      updateRuntimeNode(deviceId, {
        otaStatus: patch.otaStatus ?? previous.otaStatus ?? "idle",
        otaTargetVersion:
          patch.otaTargetVersion !== undefined
            ? patch.otaTargetVersion
            : previous.otaTargetVersion ?? null,
        otaProgressBytesSent:
          patch.otaProgressBytesSent !== undefined
            ? patch.otaProgressBytesSent
            : previous.otaProgressBytesSent ?? null,
        otaTotalBytes:
          patch.otaTotalBytes !== undefined
            ? patch.otaTotalBytes
            : previous.otaTotalBytes ?? null,
        otaLastPhase:
          patch.otaLastPhase !== undefined ? patch.otaLastPhase : previous.otaLastPhase ?? null,
        otaFailureDetail:
          patch.otaFailureDetail !== undefined
            ? patch.otaFailureDetail
            : previous.otaFailureDetail ?? null,
        otaLastStatusMessage:
          patch.otaLastStatusMessage !== undefined
            ? patch.otaLastStatusMessage
            : previous.otaLastStatusMessage ?? null,
        otaUpdatedAt: nowIso(),
      });
      emitDevice(deviceId);
      broadcastGatewayStatus();
    },
  };
}
