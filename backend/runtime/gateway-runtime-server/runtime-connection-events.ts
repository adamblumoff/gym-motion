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

export function createRuntimeConnectionEventHandlers({
  runtimeByDeviceId,
  knownNodesByDeviceId,
  gatewayState,
  knownNodeStore,
  touchGatewayState,
  broadcastGatewayStatus,
  upsertDiscovery,
  emitDevice,
  upsertKnownNode,
  resolveKnownDeviceIdByDiscovery,
  updateRuntimeNode,
  inspectNodeConnection,
  nowIso,
  reconnectDisconnectGraceMs,
}: {
  runtimeByDeviceId: Map<string, RuntimeNode>;
  knownNodesByDeviceId: Map<string, KnownNode>;
  gatewayState: GatewayStatusSummary;
  knownNodeStore: KnownNodeStore;
  touchGatewayState: TouchGatewayState;
  broadcastGatewayStatus: () => void;
  upsertDiscovery: (payload: DiscoveryUpsertPayload) => unknown;
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

  function scheduleReconnectDisconnect(
    deviceId: string,
    pending: Omit<PendingReconnectDisconnect, "token" | "timer">,
  ) {
    clearPendingReconnectDisconnect(deviceId);

    const token = Symbol("reconnect-disconnect");
    const timer = setTimeout(() => {
      finalizeReconnectDisconnect(deviceId, token);
    }, reconnectDisconnectGraceMs);
    timer.unref?.();

    pendingReconnectDisconnects.set(deviceId, {
      ...pending,
      token,
      timer,
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

  function noteDiscovery({
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
  }

  function clearReconnectDecision({
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
  }

  function cancelPendingReconnectDisconnects() {
    for (const [deviceId] of pendingReconnectDisconnects.entries()) {
      clearPendingReconnectDisconnect(deviceId);
    }
  }

  return {
    applyGatewayConnectionState,
    noteDiscovery,
    noteConnecting,
    noteConnected,
    noteDisconnected,
    clearReconnectDecision,
    cancelPendingReconnectDisconnects,
    clearPendingReconnectDisconnect,
  };
}
