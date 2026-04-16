import type { GatewayStatusSummary } from "@core/contracts";
import type {
  DiscoveryLocator,
  DiscoveryUpsertPayload,
  EmitDevice,
  KnownNode,
  KnownNodeStore,
  NodeConnectionInspection,
  RuntimeDeviceEventPayload,
  RuntimeGatewayConnectionEvent,
  RuntimeNode,
  RuntimeNodePatch,
  RuntimeDeviceMetadata,
  TelemetryPayload,
  TelemetryPeripheralInfo,
  TouchGatewayState,
} from "./runtime-types.js";

type PendingReconnectDisconnect = {
  peripheralId?: string | null;
  address?: string | null;
  reason: string;
  reconnectAttempt?: number | null;
  reconnectAttemptLimit?: number | null;
  reconnectRetryExhausted?: boolean | null;
  reconnectAwaitingDecision?: boolean | null;
  token: symbol;
  timer: ReturnType<typeof setTimeout>;
};

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
  reconnectDisconnectGraceMs,
}: {
  metadataByDeviceId: Map<string, RuntimeDeviceMetadata>;
  runtimeByDeviceId: Map<string, RuntimeNode>;
  knownNodesByDeviceId: Map<string, KnownNode>;
  suppressedDeviceIds: Set<string>;
  deviceIdByPeripheralId: Map<string, string>;
  gatewayState: GatewayStatusSummary;
  knownNodeStore: KnownNodeStore;
  refreshMetadata: (force?: boolean) => Promise<void>;
  touchGatewayState: TouchGatewayState;
  broadcastGatewayStatus: () => void;
  upsertDiscovery: (payload: DiscoveryUpsertPayload) => unknown;
  removeDiscoveryEntries: (
    payload: Required<Pick<DiscoveryLocator, "knownDeviceId" | "peripheralId" | "address" | "localName">>,
  ) => void;
  emitDevice: EmitDevice;
  upsertKnownNode: (deviceId: string | null | undefined, patch?: Partial<KnownNode>) => void;
  resolveKnownDeviceIdByDiscovery: (input: DiscoveryLocator) => string | null;
  updateRuntimeNode: (deviceId: string | null | undefined, patch: RuntimeNodePatch) => void;
  inspectNodeConnection: (input: DiscoveryLocator) => NodeConnectionInspection | null;
  nowIso: () => string;
  reconnectDisconnectGraceMs: number;
}) {
  const pendingReconnectDisconnects = new Map<string, PendingReconnectDisconnect>();

  function clearPendingReconnectDisconnect(deviceId: string | null | undefined) {
    if (!deviceId) {
      return null;
    }

    const pending = pendingReconnectDisconnects.get(deviceId) ?? null;
    if (!pending) {
      return null;
    }

    clearTimeout(pending.timer);
    pendingReconnectDisconnects.delete(deviceId);
    return pending;
  }

  function isReconnectInFlight(connectionState?: RuntimeNode["gatewayConnectionState"] | null) {
    return connectionState === "connecting" || connectionState === "reconnecting";
  }

  function finalizeReconnectDisconnect(deviceId: string, token: symbol) {
    const pending = pendingReconnectDisconnects.get(deviceId) ?? null;
    if (!pending || pending.token !== token) {
      return;
    }

    pendingReconnectDisconnects.delete(deviceId);

    const runtime = runtimeByDeviceId.get(deviceId) ?? null;
    if (!isReconnectInFlight(runtime?.gatewayConnectionState)) {
      return;
    }

    updateRuntimeNode(deviceId, {
      peripheralId: pending.peripheralId,
      address: pending.address,
      gatewayConnectionState: "disconnected",
      gatewayLastDisconnectedAt: nowIso(),
      gatewayDisconnectReason: pending.reason,
      reconnectAttempt:
        pending.reconnectAttempt ?? runtimeByDeviceId.get(deviceId)?.reconnectAttempt ?? 0,
      reconnectAttemptLimit:
        pending.reconnectAttemptLimit ??
        runtimeByDeviceId.get(deviceId)?.reconnectAttemptLimit ??
        20,
      reconnectRetryExhausted:
        pending.reconnectRetryExhausted ??
        runtimeByDeviceId.get(deviceId)?.reconnectRetryExhausted ??
        false,
      reconnectAwaitingDecision:
        pending.reconnectAwaitingDecision ??
        runtimeByDeviceId.get(deviceId)?.reconnectAwaitingDecision ??
        false,
    });
    emitDevice(deviceId);
    broadcastGatewayStatus();
  }

  function scheduleReconnectDisconnect(deviceId: string, pending: Omit<PendingReconnectDisconnect, "token" | "timer">) {
    clearPendingReconnectDisconnect(deviceId);

    const token = Symbol("reconnect-disconnect");
    const timer = setTimeout(() => {
      finalizeReconnectDisconnect(deviceId, token);
    }, reconnectDisconnectGraceMs);
    timer?.unref?.();

    pendingReconnectDisconnects.set(deviceId, {
      ...pending,
      token,
      timer,
    });
  }

  function applyGatewayConnectionState({
    connectionState,
    reason = null,
    ...payload
  }: RuntimeGatewayConnectionEvent) {
    if (connectionState === "connecting" || connectionState === "reconnecting") {
      return noteConnecting(payload);
    }

    if (connectionState === "connected") {
      return noteConnected(payload);
    }

    return noteDisconnected({
      ...payload,
      reason: reason ?? "ble-disconnected",
    });
  }

  function noteConnecting({
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
  }: RuntimeDeviceEventPayload) {
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

    clearPendingReconnectDisconnect(resolvedDeviceId);

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
  }

  function noteConnected({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    address,
    localName,
    rssi,
    reconnectAttempt = null,
    reconnectAttemptLimit = null,
    reconnectAwaitingDecision = null,
  }: RuntimeDeviceEventPayload) {
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

    clearPendingReconnectDisconnect(resolvedDeviceId);

    updateRuntimeNode(resolvedDeviceId, {
      peripheralId,
      address: address ?? null,
      gatewayConnectionState: "connected",
      gatewayLastConnectedAt: nowIso(),
      gatewayDisconnectReason: null,
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
  }

  function noteDisconnected({
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
  }: RuntimeDeviceEventPayload & { reason?: string | null }) {
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

    if (isReconnectInFlight(previous?.gatewayConnectionState)) {
      scheduleReconnectDisconnect(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        reason: reason ?? "ble-disconnected",
        reconnectAttempt,
        reconnectAttemptLimit,
        reconnectRetryExhausted,
        reconnectAwaitingDecision,
      });
      return {
        applied: false,
        provisional: true,
        before: previous,
        after: inspectNodeConnection({ deviceId: resolvedDeviceId }),
      };
    }

    clearPendingReconnectDisconnect(resolvedDeviceId);

    updateRuntimeNode(resolvedDeviceId, {
      peripheralId,
      address: address ?? null,
      gatewayConnectionState: "disconnected",
      gatewayLastDisconnectedAt: nowIso(),
      gatewayDisconnectReason: reason ?? "ble-disconnected",
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
  }

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
    }: RuntimeDeviceEventPayload) {
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

    applyGatewayConnectionState,

    noteConnecting,

    noteConnected,

    async noteTelemetry(payload: TelemetryPayload, peripheralInfo: TelemetryPeripheralInfo = {}) {
      const previous = inspectNodeConnection({ deviceId: payload.deviceId });
      const telemetryAt = nowIso();
      const previousRuntime = runtimeByDeviceId.get(payload.deviceId) ?? null;
      clearPendingReconnectDisconnect(payload.deviceId);
      const nextConnectionState =
        previousRuntime?.gatewayConnectionState === "connecting" ||
        previousRuntime?.gatewayConnectionState === "reconnecting"
          ? previousRuntime.gatewayConnectionState
          : "connected";

      updateRuntimeNode(payload.deviceId, {
        peripheralId:
          peripheralInfo.peripheralId ??
          previousRuntime?.peripheralId ??
          knownNodesByDeviceId.get(payload.deviceId)?.peripheralId ??
          null,
        address:
          peripheralInfo.address ??
          previousRuntime?.address ??
          knownNodesByDeviceId.get(payload.deviceId)?.lastKnownAddress ??
          null,
        gatewayConnectionState: nextConnectionState,
        gatewayLastConnectedAt: previousRuntime?.gatewayLastConnectedAt ?? telemetryAt,
        gatewayDisconnectReason: null,
        gatewayLastTelemetryAt: telemetryAt,
        gatewayLastAdvertisementAt:
          previousRuntime?.gatewayLastAdvertisementAt ?? telemetryAt,
        advertisedName: peripheralInfo.localName ?? null,
        lastRssi: peripheralInfo.rssi ?? null,
        lastState: payload.state,
        sensorIssue: payload.sensorIssue ?? null,
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
          previousRuntime?.gatewayLastConnectedAt ?? telemetryAt,
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

    noteDisconnected,

    clearReconnectDecision({
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

      clearPendingReconnectDisconnect(resolvedDeviceId);

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
    },

    forgetDevice({
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

    noteOtaStatus(deviceId: string | null | undefined, patch: Partial<Pick<
      RuntimeNode,
      | "otaStatus"
      | "otaTargetVersion"
      | "otaProgressBytesSent"
      | "otaTotalBytes"
      | "otaLastPhase"
      | "otaFailureDetail"
      | "otaLastStatusMessage"
    >>) {
      if (!deviceId) {
        return;
      }

      const previous: Partial<RuntimeNode> = runtimeByDeviceId.get(deviceId) ?? {};

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

    cancelPendingReconnectDisconnects() {
      for (const [deviceId] of pendingReconnectDisconnects.entries()) {
        clearPendingReconnectDisconnect(deviceId);
      }
    },
  };
}
