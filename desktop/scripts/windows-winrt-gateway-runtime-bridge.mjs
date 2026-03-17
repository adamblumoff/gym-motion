import { sendToDesktop as defaultSendToDesktop } from "./windows-winrt-gateway-desktop-ipc.mjs";
import { createDeviceContext, describeNode } from "./windows-winrt-gateway-node.mjs";

function telemetryQueueKey(payload) {
  return payload.deviceId;
}

export function createRuntimeBridge({
  config,
  runtimeServer,
  debug,
  sendToDesktop = defaultSendToDesktop,
}) {
  const deviceContexts = new Map();
  const telemetryForwardChains = new Map();

  function emitPersistMessage(type, deviceId, payload) {
    if (!sendToDesktop({ type, deviceId, payload }, debug)) {
      debug(`skipped ${type} for ${deviceId} because desktop IPC is unavailable`);
    }
  }

  async function forwardTelemetryNow(payload, node = {}) {
    let context = deviceContexts.get(payload.deviceId);

    if (!context) {
      context = createDeviceContext(payload.deviceId);
      deviceContexts.set(payload.deviceId, context);
    }

    context.firmwareVersion = payload.firmwareVersion ?? context.firmwareVersion;
    context.bootId = payload.bootId ?? context.bootId ?? null;
    context.hardwareId = payload.hardwareId ?? context.hardwareId ?? null;
    context.peripheralId = node.peripheralId ?? context.peripheralId ?? null;
    context.address = node.address ?? context.address ?? null;
    context.advertisedName = node.localName ?? context.advertisedName ?? null;
    context.rssi = node.lastRssi ?? node.rssi ?? context.rssi ?? null;

    const peripheralInfo = {
      ...describeNode(node),
      deviceId: payload.deviceId,
      knownDeviceId: payload.deviceId,
    };

    await runtimeServer.noteTelemetry(payload, peripheralInfo);

    const stateChanged = context.lastState !== payload.state;

    if (stateChanged) {
      emitPersistMessage("persist-motion", payload.deviceId, {
        deviceId: payload.deviceId,
        state: payload.state,
        timestamp: payload.timestamp,
        delta: payload.delta ?? null,
        sequence: payload.sequence,
        bootId: payload.bootId,
        firmwareVersion: payload.firmwareVersion,
        hardwareId: payload.hardwareId,
      });
      context.lastState = payload.state;
      context.lastHeartbeatForwardedAt = Date.now();
      return;
    }

    if (Date.now() - context.lastHeartbeatForwardedAt < config.heartbeatMinIntervalMs) {
      return;
    }

    emitPersistMessage("persist-heartbeat", payload.deviceId, {
      deviceId: payload.deviceId,
      timestamp: payload.timestamp,
      bootId: payload.bootId,
      firmwareVersion: payload.firmwareVersion,
      hardwareId: payload.hardwareId,
    });
    context.lastHeartbeatForwardedAt = Date.now();
  }

  function forwardTelemetry(payload, node = {}) {
    const key = telemetryQueueKey(payload);
    const current = telemetryForwardChains.get(key) ?? Promise.resolve();
    const next = current.then(
      () => forwardTelemetryNow(payload, node),
      () => forwardTelemetryNow(payload, node),
    );
    const tracked = next.catch(() => {});
    telemetryForwardChains.set(key, tracked);

    return next.finally(() => {
      if (telemetryForwardChains.get(key) === tracked) {
        telemetryForwardChains.delete(key);
      }
    });
  }

  function handleNodeDiscovered(node, scanReason = null) {
    const peripheralInfo = describeNode(node);

    if (scanReason === "manual") {
      runtimeServer.upsertManualScanCandidate({
        id: node.id,
        label:
          node.localName ??
          node.local_name ??
          node.knownDeviceId ??
          node.known_device_id ??
          node.peripheralId ??
          node.peripheral_id ??
          "Visible node",
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
        address: node.address ?? null,
        localName: node.localName ?? node.local_name ?? null,
        knownDeviceId: node.knownDeviceId ?? node.known_device_id ?? null,
        machineLabel: null,
        siteId: null,
        lastRssi: node.lastRssi ?? node.last_rssi ?? node.rssi ?? null,
        lastSeenAt: node.lastSeenAt ?? node.last_seen_at ?? null,
      });
    }

    runtimeServer.noteDiscovery({
      ...peripheralInfo,
      reconnectAttempt: node.reconnect?.attempt ?? null,
      reconnectAttemptLimit: node.reconnect?.attempt_limit ?? null,
      reconnectRetryExhausted: node.reconnect?.retry_exhausted ?? null,
      reconnectAwaitingDecision: node.reconnect?.awaiting_user_decision ?? null,
    });
  }

  function handleNodeConnectionState(event) {
    const node = event.node ?? {};
    const peripheralInfo = describeNode(node);
    const connectionState =
      event.gatewayConnectionState ?? event.gateway_connection_state ?? "disconnected";

    if (connectionState === "connecting") {
      runtimeServer.noteConnecting({
        ...peripheralInfo,
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
        reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
      });
      return;
    }

    if (connectionState === "connected") {
      runtimeServer.noteConnected({
        ...peripheralInfo,
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
      });
      return;
    }

    const transition = runtimeServer.noteDisconnected({
      ...peripheralInfo,
      reason: event.reason ?? "ble-disconnected",
      reconnectAttempt: event.reconnect?.attempt ?? null,
      reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
      reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
      reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
    });
    if (!transition?.applied) {
      return;
    }

    if (transition.before?.gatewayConnectionState === "disconnected") {
      return;
    }
  }

  return {
    forwardTelemetry,
    handleNodeDiscovered,
    handleNodeConnectionState,
  };
}
