// @ts-nocheck
import { sendToDesktop as defaultSendToDesktop } from "./windows-winrt-gateway-desktop-ipc.js";
import { createDeviceContext, describeNode } from "./windows-winrt-gateway-node.js";

function logBackfill(message, details) {
  if (details !== undefined) {
    console.info(`[runtime] ${message}`, details);
    return;
  }

  console.info(`[runtime] ${message}`);
}

function trimMessage(message) {
  const normalized = typeof message === "string" ? message.trim() : "";

  if (normalized.length <= 280) {
    return normalized;
  }

  return `${normalized.slice(0, 277)}...`;
}

function telemetryQueueKey(payload) {
  return payload.deviceId;
}

function pendingLogKey(peripheralInfo) {
  return peripheralInfo.peripheralId ?? peripheralInfo.localName ?? "unknown";
}

export function createRuntimeBridge({
  config,
  runtimeServer,
  debug,
  sendToDesktop = defaultSendToDesktop,
  sendSidecarCommand = async () => {},
  fetchImpl = globalThis.fetch.bind(globalThis),
}) {
  const deviceContexts = new Map();
  const pendingNodeLogs = new Map();
  const telemetryForwardChains = new Map();
  const historySyncByDevice = new Map();

  function emitPersistMessage(type, deviceId, payload) {
    if (!sendToDesktop({ type, deviceId, payload }, debug)) {
      debug(`skipped ${type} for ${deviceId} because desktop IPC is unavailable`);
    }
  }

  function writeDeviceLog({
    deviceId,
    level = "info",
    code,
    message,
    bootId,
    firmwareVersion,
    hardwareId,
    metadata,
  }) {
    emitPersistMessage("persist-device-log", deviceId, {
      deviceId,
      level,
      code,
      message: trimMessage(message),
      bootId,
      firmwareVersion,
      hardwareId,
      metadata,
    });
  }

  function queueNodeLog(peripheralInfo, entry) {
    const key = pendingLogKey(peripheralInfo);
    const knownDeviceId = runtimeServer.resolveKnownDeviceId(peripheralInfo);

    if (knownDeviceId) {
      writeDeviceLog({
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
    const key = pendingLogKey(peripheralInfo);
    const pendingEntries = pendingNodeLogs.get(key);

    if (!pendingEntries?.length) {
      return;
    }

    pendingNodeLogs.delete(key);

    for (const entry of pendingEntries) {
      writeDeviceLog({
        deviceId,
        level: entry.level,
        code: entry.code,
        message: entry.message,
        bootId: devicePayload?.bootId ?? undefined,
        firmwareVersion: devicePayload?.firmwareVersion ?? undefined,
        hardwareId: devicePayload?.hardwareId ?? undefined,
        metadata: entry.metadata,
      });
    }
  }

  function desktopApiUrl(pathname, search = "") {
    return `${config.desktopApiBaseUrl}${pathname}${search}`;
  }

  async function fetchDesktopJson(pathname, init) {
    const response = await fetchImpl(desktopApiUrl(pathname), {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-store",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      ...init,
    });

    if (!response.ok) {
      throw new Error(`${pathname} -> ${response.status}`);
    }

    return await response.json();
  }

  async function beginHistorySyncForDevice(context, payload) {
    if (!payload.deviceId || !payload.bootId) {
      return;
    }

    if (!config.desktopApiBaseUrl || config.desktopApiBaseUrl.endsWith(":0")) {
      return;
    }

    if (
      context.historySyncActiveBootId === payload.bootId ||
      context.historySyncCompletedBootId === payload.bootId ||
      context.historySyncFailedBootId === payload.bootId
    ) {
      return;
    }

    context.historySyncActiveBootId = payload.bootId;

    try {
      const syncResponse = await fetchDesktopJson(
        `/api/device-sync/${encodeURIComponent(payload.deviceId)}?bootId=${encodeURIComponent(payload.bootId)}`,
      );
      const afterSequence = syncResponse?.syncState?.lastAckedSequence ?? 0;

      historySyncByDevice.set(payload.deviceId, {
        deviceId: payload.deviceId,
        bootId: payload.bootId,
        records: [],
        requestedAfterSequence: afterSequence,
        latestSequence: afterSequence,
        highWaterSequence: afterSequence,
        firmwareVersion: payload.firmwareVersion ?? null,
        hardwareId: payload.hardwareId ?? null,
      });

      logBackfill("requesting history sync", {
        deviceId: payload.deviceId,
        bootId: payload.bootId,
        afterSequence,
        maxRecords: 0,
      });

      await sendSidecarCommand({
        type: "begin_history_sync",
        device_id: payload.deviceId,
        after_sequence: afterSequence,
        max_records: 0,
      });
    } catch (error) {
      context.historySyncActiveBootId = null;
      context.historySyncFailedBootId = payload.bootId;
      historySyncByDevice.delete(payload.deviceId);
      logBackfill("history sync request failed", {
        deviceId: payload.deviceId,
        bootId: payload.bootId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleHistorySyncCompleteNow(event) {
    const payload = event.payload ?? {};
    const deviceId = payload.device_id;
    const state = historySyncByDevice.get(deviceId);

    if (!deviceId || !state) {
      return;
    }

    const context = deviceContexts.get(deviceId);

    state.latestSequence = payload.latest_sequence ?? state.latestSequence;
    state.highWaterSequence = payload.high_water_sequence ?? state.highWaterSequence;

    if ((payload.sent_count ?? 0) === 0 && payload.has_more === false) {
      historySyncByDevice.delete(deviceId);
      if (context?.historySyncActiveBootId === state.bootId) {
        context.historySyncActiveBootId = null;
        context.historySyncCompletedBootId = state.bootId;
      }
      logBackfill("history sync completed without new records", {
        deviceId,
        bootId: state.bootId,
        latestSequence: payload.latest_sequence ?? 0,
        highWaterSequence: payload.high_water_sequence ?? 0,
      });
      return;
    }

    const records = state.records.splice(0);

    if (records.length !== (payload.sent_count ?? 0)) {
      historySyncByDevice.delete(deviceId);
      if (context?.historySyncActiveBootId === state.bootId) {
        context.historySyncActiveBootId = null;
        context.historySyncFailedBootId = state.bootId;
      }
      logBackfill("history sync record count mismatch", {
        deviceId,
        bootId: state.bootId,
        expectedRecordCount: payload.sent_count ?? 0,
        actualRecordCount: records.length,
      });
      return;
    }

    logBackfill("persisting backfill batch", {
      deviceId,
      bootId: state.bootId,
      ackSequence: payload.latest_sequence ?? 0,
      recordCount: records.length,
    });

    try {
      const result = await fetchDesktopJson("/api/device-backfill", {
        method: "POST",
        body: JSON.stringify({
          deviceId,
          bootId: state.bootId,
          records,
          ackSequence: payload.latest_sequence ?? 0,
          ...(payload.overflowed ? { overflowDetectedAt: new Date().toISOString() } : {}),
        }),
      });

      const provenAckSequence = result?.syncState?.lastAckedSequence ?? 0;

      logBackfill("persisted backfill batch", {
        deviceId,
        bootId: state.bootId,
        ackSequence: payload.latest_sequence ?? 0,
        recordCount: records.length,
        provenAckSequence,
      });

      await sendSidecarCommand({
        type: "acknowledge_history_sync",
        device_id: deviceId,
        sequence: provenAckSequence,
      });

      const noProgress = provenAckSequence <= state.requestedAfterSequence;
      const shouldContinue =
        payload.has_more === true ||
        (provenAckSequence < (payload.latest_sequence ?? 0) && !noProgress);

      if (shouldContinue) {
        state.requestedAfterSequence = provenAckSequence;
        logBackfill("requesting next history sync page", {
          deviceId,
          bootId: state.bootId,
          afterSequence: provenAckSequence,
          highWaterSequence: payload.high_water_sequence ?? 0,
          hasMore: payload.has_more ?? false,
        });
        await sendSidecarCommand({
          type: "begin_history_sync",
          device_id: deviceId,
          after_sequence: provenAckSequence,
          max_records: 0,
        });
        return;
      }

      historySyncByDevice.delete(deviceId);
      if (context?.historySyncActiveBootId === state.bootId) {
        context.historySyncActiveBootId = null;
        context.historySyncCompletedBootId = state.bootId;
      }

      if (provenAckSequence < (payload.latest_sequence ?? 0)) {
        logBackfill("history sync stopped after no forward progress", {
          deviceId,
          bootId: state.bootId,
          requestedAfterSequence: state.requestedAfterSequence,
          provenAckSequence,
          latestSequence: payload.latest_sequence ?? 0,
        });
      }
    } catch (error) {
      historySyncByDevice.delete(deviceId);
      if (context?.historySyncActiveBootId === state.bootId) {
        context.historySyncActiveBootId = null;
        context.historySyncFailedBootId = state.bootId;
      }
      logBackfill("history sync persistence failed", {
        deviceId,
        bootId: state.bootId,
        detail: error instanceof Error ? error.message : String(error),
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

    await runtimeServer.noteTelemetry(payload, peripheralInfo);
    const historySyncPromise =
      config.desktopApiBaseUrl && !config.desktopApiBaseUrl.endsWith(":0")
        ? beginHistorySyncForDevice(context, payload)
        : null;

    const stateChanged = context.lastState !== payload.state;
    const snapshotTelemetry = payload.snapshot === true;

    if (!snapshotTelemetry && stateChanged) {
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
      if (historySyncPromise) {
        await historySyncPromise;
      }
      return;
    }

    if (Date.now() - context.lastHeartbeatForwardedAt < config.heartbeatMinIntervalMs) {
      context.lastState = payload.state;
      if (historySyncPromise) {
        await historySyncPromise;
      }
      return;
    }

    emitPersistMessage("persist-heartbeat", payload.deviceId, {
      deviceId: payload.deviceId,
      timestamp: payload.timestamp,
      bootId: payload.bootId,
      firmwareVersion: payload.firmwareVersion,
      hardwareId: payload.hardwareId,
    });
    context.lastState = payload.state;
    context.lastHeartbeatForwardedAt = Date.now();
    if (historySyncPromise) {
      await historySyncPromise;
    }
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

  function handleHistoryRecord(event) {
    const deviceId = event.device_id;
    const state = historySyncByDevice.get(deviceId);

    if (!state) {
      return;
    }

    state.records.push(event.record);
  }

  function handleHistorySyncComplete(event) {
    const deviceId = event?.payload?.device_id;
    if (!deviceId) {
      return Promise.resolve();
    }
    const current = telemetryForwardChains.get(deviceId) ?? Promise.resolve();
    const next = current.then(
      () => handleHistorySyncCompleteNow(event),
      () => handleHistorySyncCompleteNow(event),
    );
    const tracked = next.catch(() => {});
    telemetryForwardChains.set(deviceId, tracked);

    return next.finally(() => {
      if (telemetryForwardChains.get(deviceId) === tracked) {
        telemetryForwardChains.delete(deviceId);
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
    const label =
      node.localName ?? node.local_name ?? node.peripheralId ?? node.peripheral_id ?? "a BLE node";
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

    const knownDeviceId = runtimeServer.resolveKnownDeviceId(peripheralInfo);
    const context = knownDeviceId ? deviceContexts.get(knownDeviceId) : null;
    if (knownDeviceId) {
      historySyncByDevice.delete(knownDeviceId);
    }
    if (context) {
      context.historySyncActiveBootId = null;
      context.historySyncFailedBootId = null;
    }
  }

  return {
    forwardTelemetry,
    handleHistoryRecord,
    handleHistorySyncComplete,
    handleNodeDiscovered,
    handleNodeConnectionState,
  };
}
