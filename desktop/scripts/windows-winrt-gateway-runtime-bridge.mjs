/* global fetch */

import {
  shouldWriteDiscoveryLog,
} from "./windows-winrt-gateway-logging.mjs";
import {
  createDeviceContext,
  describeNode,
} from "./windows-winrt-gateway-node.mjs";

export function createRuntimeBridge({ config, runtimeServer, debug }) {
  const deviceContexts = new Map();
  const pendingNodeLogs = new Map();
  let telemetryForwardChain = Promise.resolve();

  async function postJson(targetPath, body) {
    const response = await fetch(`${config.apiBaseUrl}${targetPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${targetPath} -> ${response.status}: ${text}`);
    }

    return await response.json();
  }

  async function writeDeviceLog({
    deviceId,
    level = "info",
    code,
    message,
    bootId,
    firmwareVersion,
    hardwareId,
    metadata,
  }) {
    try {
      await postJson("/api/device-logs", {
        deviceId,
        level,
        code,
        message,
        bootId,
        firmwareVersion,
        hardwareId,
        metadata,
      });
    } catch (error) {
      debug(
        `failed to write gateway log ${code}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function queueNodeLog(peripheralInfo, entry) {
    const key = peripheralInfo.peripheralId ?? peripheralInfo.localName ?? "unknown";
    const knownDeviceId = runtimeServer.resolveKnownDeviceId(peripheralInfo);

    if (knownDeviceId) {
      void writeDeviceLog({
        deviceId: knownDeviceId,
        ...entry,
      });
      return;
    }

    const pendingEntries = pendingNodeLogs.get(key) ?? [];
    pendingEntries.push({
      ...entry,
      peripheralInfo,
    });
    pendingNodeLogs.set(key, pendingEntries);
  }

  function flushNodeLogs(deviceId, peripheralInfo, devicePayload) {
    const key = peripheralInfo.peripheralId ?? peripheralInfo.localName ?? "unknown";
    const pendingEntries = pendingNodeLogs.get(key);

    if (!pendingEntries?.length) {
      return;
    }

    pendingNodeLogs.delete(key);

    for (const entry of pendingEntries) {
      void writeDeviceLog({
        deviceId,
        level: entry.level,
        code: entry.code,
        message: entry.message,
        bootId: devicePayload?.bootId ?? null,
        firmwareVersion: devicePayload?.firmwareVersion ?? null,
        hardwareId: devicePayload?.hardwareId ?? null,
        metadata: entry.metadata,
      });
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

    flushNodeLogs(payload.deviceId, peripheralInfo, payload);

    const telemetryResult = await runtimeServer.noteTelemetry(payload, peripheralInfo);
    const connectionStateBeforeTelemetry =
      telemetryResult?.before?.gatewayConnectionState ?? null;

    if (
      connectionStateBeforeTelemetry &&
      connectionStateBeforeTelemetry !== "connected" &&
      context.lastTelemetryConnectionState !== connectionStateBeforeTelemetry
    ) {
      void writeDeviceLog({
        deviceId: payload.deviceId,
        level: "warn",
        code: "node.telemetry_without_transport",
        message: `Telemetry arrived while transport state was ${connectionStateBeforeTelemetry}.`,
        bootId: payload.bootId ?? null,
        firmwareVersion: payload.firmwareVersion ?? null,
        hardwareId: payload.hardwareId ?? null,
        metadata: {
          peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
          address: node.address ?? null,
          transportStateBefore: connectionStateBeforeTelemetry,
          transportStateAfter: telemetryResult?.after?.gatewayConnectionState ?? null,
          telemetryFreshnessAfter: telemetryResult?.after?.telemetryFreshness ?? null,
          lastTelemetryAt: telemetryResult?.after?.lastTelemetryAt ?? null,
          lastConnectedAt: telemetryResult?.after?.lastConnectedAt ?? null,
          lastDisconnectedAt: telemetryResult?.after?.lastDisconnectedAt ?? null,
        },
      });
    }
    context.lastTelemetryConnectionState = connectionStateBeforeTelemetry;

    const stateChanged = context.lastState !== payload.state;

    if (stateChanged) {
      await postJson("/api/ingest", {
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

    await postJson("/api/heartbeat", {
      deviceId: payload.deviceId,
      timestamp: payload.timestamp,
      bootId: payload.bootId,
      firmwareVersion: payload.firmwareVersion,
      hardwareId: payload.hardwareId,
    });
    context.lastHeartbeatForwardedAt = Date.now();
  }

  function forwardTelemetry(payload, node = {}) {
    const nextForward = telemetryForwardChain.then(
      () => forwardTelemetryNow(payload, node),
      () => forwardTelemetryNow(payload, node),
    );
    telemetryForwardChain = nextForward.catch(() => {});
    return nextForward;
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

    if (!shouldWriteDiscoveryLog(scanReason)) {
      return;
    }

    queueNodeLog(peripheralInfo, {
      code: "node.discovered",
      message: `Gateway discovered ${node.localName ?? node.local_name ?? node.peripheralId ?? node.peripheral_id ?? "a BLE node"}.`,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
        address: node.address ?? null,
        advertisedName: node.localName ?? node.local_name ?? null,
        rssi: node.lastRssi ?? node.last_rssi ?? node.rssi ?? null,
      },
    });
  }

  function handleNodeConnectionState(event) {
    const node = event.node ?? {};
    const peripheralInfo = describeNode(node);
    const label =
      node.localName ?? node.local_name ?? node.peripheralId ?? node.peripheral_id ?? "a BLE node";
    const connectionState =
      event.gatewayConnectionState ?? event.gateway_connection_state ?? "disconnected";

    if (connectionState === "connecting") {
      const transition = runtimeServer.noteConnecting({
        ...peripheralInfo,
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
        reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
      });
      queueNodeLog(peripheralInfo, {
        code: "node.connecting",
        message: `Gateway is connecting to ${label}.`,
        metadata: {
          peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
          address: node.address ?? null,
          reconnectAttempt: event.reconnect?.attempt ?? null,
          reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
          reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
          reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
          transportStateBefore: transition?.before?.gatewayConnectionState ?? null,
          transportStateAfter: transition?.after?.gatewayConnectionState ?? "connecting",
          lastTelemetryAt: transition?.after?.lastTelemetryAt ?? null,
          lastConnectedAt: transition?.after?.lastConnectedAt ?? null,
          lastDisconnectedAt: transition?.after?.lastDisconnectedAt ?? null,
        },
      });
      return;
    }

    if (connectionState === "connected") {
      const transition = runtimeServer.noteConnected({
        ...peripheralInfo,
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
      });
      queueNodeLog(peripheralInfo, {
        code: "node.connected",
        message: `Gateway connected to ${label}.`,
        metadata: {
          peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
          address: node.address ?? null,
          reconnectAttempt: event.reconnect?.attempt ?? null,
          reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
          transportStateBefore: transition?.before?.gatewayConnectionState ?? null,
          transportStateAfter: transition?.after?.gatewayConnectionState ?? "connected",
          lastTelemetryAt: transition?.after?.lastTelemetryAt ?? null,
          lastConnectedAt: transition?.after?.lastConnectedAt ?? null,
          lastDisconnectedAt: transition?.after?.lastDisconnectedAt ?? null,
        },
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
      queueNodeLog(peripheralInfo, {
        level: "warn",
        code: "node.disconnect_ignored",
        message: `Gateway ignored a transient disconnect signal for ${label}.`,
        metadata: {
          peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
          address: node.address ?? null,
          reason: event.reason ?? "ble-disconnected",
          reconnectAttempt: event.reconnect?.attempt ?? null,
          reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
          reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
          reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
          transportStateBefore: transition?.before?.gatewayConnectionState ?? null,
          transportStateAfter: transition?.after?.gatewayConnectionState ?? null,
          lastTelemetryAt: transition?.before?.lastTelemetryAt ?? null,
          lastConnectedAt: transition?.before?.lastConnectedAt ?? null,
          lastDisconnectedAt: transition?.before?.lastDisconnectedAt ?? null,
        },
      });
      return;
    }

    if (transition.before?.gatewayConnectionState === "disconnected") {
      return;
    }

    queueNodeLog(peripheralInfo, {
      level: "warn",
      code: "node.disconnected",
      message: `Gateway lost ${label}.`,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
        address: node.address ?? null,
        reason: event.reason ?? "ble-disconnected",
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
        reconnectAwaitingDecision: event.reconnect?.awaiting_user_decision ?? null,
        transportStateBefore: transition.before?.gatewayConnectionState ?? null,
        transportStateAfter: transition.after?.gatewayConnectionState ?? connectionState,
        lastTelemetryAt:
          transition.after?.lastTelemetryAt ?? transition.before?.lastTelemetryAt ?? null,
        lastConnectedAt:
          transition.after?.lastConnectedAt ?? transition.before?.lastConnectedAt ?? null,
        lastDisconnectedAt: transition.after?.lastDisconnectedAt ?? null,
      },
    });
  }

  return {
    forwardTelemetry,
    handleNodeDiscovered,
    handleNodeConnectionState,
  };
}
