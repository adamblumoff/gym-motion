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

function createHistorySyncState({
  deviceId,
  bootId,
  firmwareVersion,
  hardwareId,
}) {
  return {
    deviceId,
    bootId,
    firmwareVersion,
    hardwareId,
    status: "waiting_to_request",
    requestedAfterSequence: null,
    latestSequence: 0,
    highWaterSequence: 0,
    requestId: null,
    records: [],
    recordSequences: new Set(),
    pausedReason: null,
    completionPending: false,
  };
}

export function createRuntimeBridge({
  config,
  runtimeServer,
  debug,
  sendToDesktop = defaultSendToDesktop,
  sendSidecarCommand = async () => {},
  fetchImpl = globalThis.fetch.bind(globalThis),
  nowFn = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const deviceContexts = new Map();
  const pendingNodeLogs = new Map();
  const liveTaskChains = new Map();
  const historyTaskChains = new Map();
  const historySyncByDevice = new Map();
  const pendingHistorySyncTimers = new Map();

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

  function queueTask(taskChains, deviceId, work) {
    const current = taskChains.get(deviceId) ?? Promise.resolve();
    const next = current.then(work, work);
    const tracked = next.catch(() => {});
    taskChains.set(deviceId, tracked);

    return next.finally(() => {
      if (taskChains.get(deviceId) === tracked) {
        taskChains.delete(deviceId);
      }
    });
  }

  function queueLiveDeviceTask(deviceId, work) {
    return queueTask(liveTaskChains, deviceId, work);
  }

  function queueHistoryDeviceTask(deviceId, work) {
    return queueTask(historyTaskChains, deviceId, work);
  }

  function syncBackfillContext(context, state) {
    context.backfillStatus = state?.status ?? "idle";
    context.backfillBootId = state?.bootId ?? null;
    context.backfillNextEligibleAt = null;
    context.backfillPausedReason = state?.pausedReason ?? null;
  }

  function clearPendingHistorySyncTimer(deviceId) {
    const timer = pendingHistorySyncTimers.get(deviceId);
    if (timer !== undefined) {
      clearTimeoutImpl(timer);
      pendingHistorySyncTimers.delete(deviceId);
    }
  }

  function removeBackfillState(deviceId) {
    clearPendingHistorySyncTimer(deviceId);
    if (historySyncByDevice.has(deviceId)) {
      historySyncByDevice.delete(deviceId);
    }

    const context = deviceContexts.get(deviceId);
    if (context) {
      syncBackfillContext(context, null);
    }
  }

  function setBackfillStatus(context, state, status, updates = {}) {
    Object.assign(state, updates);
    state.status = status;
    syncBackfillContext(context, state);
  }

  function pauseBackfill(context, state, reason, details = undefined) {
    setBackfillStatus(context, state, "paused_after_error", {
      records: [],
      recordSequences: new Set(),
      pausedReason: reason,
    });
    logBackfill(reason, details);
  }

  function completeBackfill(context, state, details = undefined) {
    clearPendingHistorySyncTimer(state.deviceId);
    setBackfillStatus(context, state, "complete", {
      records: [],
      recordSequences: new Set(),
      pausedReason: null,
    });
    if (details) {
      logBackfill("history sync complete", details);
    }
  }

  function createHistoryRequestId() {
    const nowToken = Math.max(0, Math.trunc(nowFn())).toString(36);
    const randomToken = Math.floor(Math.random() * 0xffffffff)
      .toString(36)
      .padStart(6, "0")
      .slice(0, 6);
    return `h${nowToken}-${randomToken}`;
  }

  async function requestHistorySyncNow(deviceId, bootId) {
    clearPendingHistorySyncTimer(deviceId);

    const state = historySyncByDevice.get(deviceId);
    const context = deviceContexts.get(deviceId);
    if (!state || !context || state.bootId !== bootId || context.bootId !== bootId) {
      return;
    }

    if (context.lastGatewayConnectionState !== "connected") {
      logBackfill("skipping history sync request because the node is no longer connected", {
        deviceId,
        bootId,
        gatewayConnectionState: context.lastGatewayConnectionState ?? null,
      });
      return;
    }

    setBackfillStatus(context, state, "buffering_page", {
      requestedAfterSequence: state.latestSequence ?? 0,
      latestSequence: state.latestSequence ?? 0,
      highWaterSequence: state.highWaterSequence ?? state.latestSequence ?? 0,
      requestId: null,
      records: [],
      recordSequences: new Set(),
      pausedReason: null,
      completionPending: false,
    });

    logBackfill("awaiting firmware-owned history sync", {
      deviceId,
      bootId,
      requestedAfterSequence: state.latestSequence ?? 0,
    });
  }

  function scheduleHistorySyncRequest(context, state) {
    if (pendingHistorySyncTimers.has(state.deviceId)) {
      return;
    }

    const waitMs = Math.max(0, Number(config.historySyncStabilityWindowMs ?? 0));
    setBackfillStatus(context, state, "waiting_to_request", {
      pausedReason: null,
      completionPending: false,
      requestId: null,
      records: [],
      recordSequences: new Set(),
    });

    logBackfill("waiting for stable live session before history sync", {
      deviceId: state.deviceId,
      bootId: state.bootId,
      waitMs,
    });

    if (waitMs === 0) {
      void queueHistoryDeviceTask(state.deviceId, () =>
        requestHistorySyncNow(state.deviceId, state.bootId),
      );
      return;
    }

    const timer = setTimeoutImpl(() => {
      pendingHistorySyncTimers.delete(state.deviceId);
      void queueHistoryDeviceTask(state.deviceId, () =>
        requestHistorySyncNow(state.deviceId, state.bootId),
      );
    }, waitMs);
    pendingHistorySyncTimers.set(state.deviceId, timer);
  }

  function ensureBackfillState(context, payload) {
    if (!config.desktopApiBaseUrl || config.desktopApiBaseUrl.endsWith(":0")) {
      return null;
    }

    if (!payload.deviceId || !payload.bootId) {
      return null;
    }

    let state = historySyncByDevice.get(payload.deviceId);
    if (!state || state.bootId !== payload.bootId) {
      removeBackfillState(payload.deviceId);
      state = createHistorySyncState({
        deviceId: payload.deviceId,
        bootId: payload.bootId,
        firmwareVersion: payload.firmwareVersion ?? null,
        hardwareId: payload.hardwareId ?? null,
      });
      historySyncByDevice.set(payload.deviceId, state);
      syncBackfillContext(context, state);
    } else {
      state.firmwareVersion = payload.firmwareVersion ?? state.firmwareVersion ?? null;
      state.hardwareId = payload.hardwareId ?? state.hardwareId ?? null;
    }

    if (
      state.status === "waiting_to_request" ||
      state.status === "buffering_page" ||
      state.status === "persisting_page"
    ) {
      if (!pendingHistorySyncTimers.has(state.deviceId) && state.status === "waiting_to_request") {
        scheduleHistorySyncRequest(context, state);
      }
      return state;
    }

    if (state.status !== "complete" && state.status !== "paused_after_error") {
      scheduleHistorySyncRequest(context, state);
    }

    return state;
  }

  async function handleHistorySyncCompleteNow(event) {
    const payload = event.payload ?? {};
    const deviceId = payload.device_id;
    const state = historySyncByDevice.get(deviceId);
    const context = deviceContexts.get(deviceId);
    if (state) {
      state.completionPending = false;
    }

    logBackfill("received history sync completion", {
      deviceId: deviceId ?? null,
      eventBootId: payload.boot_id ?? null,
      stateBootId: state?.bootId ?? null,
      contextBootId: context?.bootId ?? null,
      status: state?.status ?? null,
      sentCount: payload.sent_count ?? null,
      latestSequence: payload.latest_sequence ?? null,
      highWaterSequence: payload.high_water_sequence ?? null,
      hasMore: payload.has_more ?? null,
      requestId: payload.request_id ?? null,
    });

    if (!deviceId || !state || !context) {
      logBackfill("ignoring history sync completion without active state", {
        deviceId: deviceId ?? null,
        hasState: Boolean(state),
        hasContext: Boolean(context),
      });
      return;
    }

    if (context.bootId !== state.bootId || state.status !== "buffering_page") {
      logBackfill("ignoring history sync completion outside active page buffer", {
        deviceId,
        contextBootId: context.bootId ?? null,
        stateBootId: state.bootId ?? null,
        status: state.status,
      });
      return;
    }

    if (!state.requestId && payload.request_id) {
      state.requestId = payload.request_id;
      logBackfill("bound history sync completion", {
        deviceId,
        requestId: state.requestId,
      });
    }

    if (payload.request_id !== state.requestId) {
      logBackfill("ignoring history sync completion for stale request", {
        deviceId,
        expectedRequestId: state.requestId ?? null,
        requestId: payload.request_id ?? null,
      });
      return;
    }

    state.latestSequence = payload.latest_sequence ?? state.latestSequence;
    state.highWaterSequence = payload.high_water_sequence ?? state.highWaterSequence;

    if ((payload.sent_count ?? 0) === 0 && payload.has_more === false) {
      completeBackfill(context, state, {
        deviceId,
        bootId: state.bootId,
        latestSequence: payload.latest_sequence ?? 0,
        highWaterSequence: payload.high_water_sequence ?? 0,
      });
      return;
    }

    const records = state.records.splice(0);
    state.recordSequences = new Set();

    const expectedRecordCount = payload.sent_count ?? 0;
    if (records.length < expectedRecordCount) {
      pauseBackfill(context, state, "history sync record count underflow", {
        deviceId,
        bootId: state.bootId,
        expectedRecordCount,
        actualRecordCount: records.length,
      });
      return;
    }

    if (records.length > expectedRecordCount) {
      pauseBackfill(context, state, "history sync record count overflow", {
        deviceId,
        expectedRecordCount,
        actualRecordCount: records.length,
        requestId: payload.request_id ?? null,
      });
      return;
    }

    setBackfillStatus(context, state, "persisting_page", {
      records: [],
      recordSequences: new Set(),
      pausedReason: null,
    });

    logBackfill("persisting backfill batch", {
      deviceId,
      bootId: state.bootId,
      ackSequence: payload.latest_sequence ?? 0,
      recordCount: records.length,
    });

    try {
      const pageBootIds = [...new Set(records.map((record) => record.bootId).filter(Boolean))];
      const pageBootId = pageBootIds.length === 1 ? pageBootIds[0] : undefined;
      const result = await fetchDesktopJson("/api/device-backfill", {
        method: "POST",
        body: JSON.stringify({
          deviceId,
          ...(pageBootId ? { bootId: pageBootId } : {}),
          records,
          ackSequence: payload.latest_sequence ?? 0,
          syncComplete: payload.has_more !== true,
          ...(payload.overflowed ? { overflowDetectedAt: new Date().toISOString() } : {}),
        }),
      });

      const durableAckSequence = result?.historySyncState?.lastAckedHistorySequence ?? 0;

      logBackfill("persisted backfill batch", {
        deviceId,
        bootId: state.bootId,
        ackSequence: payload.latest_sequence ?? 0,
        recordCount: records.length,
        durableAckSequence,
      });

      if (payload.has_more !== true) {
        completeBackfill(context, state);
        return;
      }

      setBackfillStatus(context, state, "buffering_page", {
        requestedAfterSequence: payload.latest_sequence ?? state.latestSequence ?? 0,
        requestId: payload.request_id ?? state.requestId ?? null,
        records: [],
        recordSequences: new Set(),
        pausedReason: null,
      });

      logBackfill("awaiting next firmware-owned history page", {
        deviceId,
        bootId: state.bootId,
        afterSequence: payload.latest_sequence ?? state.latestSequence ?? 0,
        durableAckSequence,
        highWaterSequence: payload.high_water_sequence ?? 0,
        hasMore: payload.has_more ?? false,
      });
    } catch (error) {
      pauseBackfill(context, state, "history sync persistence failed", {
        deviceId,
        bootId: state.bootId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleHistoryErrorNow(event) {
    const payload = event.payload ?? {};
    const deviceId = payload.device_id;
    const state = historySyncByDevice.get(deviceId);
    const context = deviceContexts.get(deviceId);

    logBackfill("received history sync error", {
      deviceId: deviceId ?? null,
      code: payload.code ?? null,
      detail: payload.message ?? null,
      requestId: payload.request_id ?? null,
      status: state?.status ?? null,
    });

    if (!deviceId || !state || !context) {
      return;
    }

    if (payload.request_id && payload.request_id !== state.requestId) {
      logBackfill("ignoring history sync error for stale request", {
        deviceId,
        expectedRequestId: state.requestId ?? null,
        requestId: payload.request_id ?? null,
      });
      return;
    }

    state.completionPending = false;
    pauseBackfill(
      context,
      state,
      "history sync failed",
      {
        deviceId,
        bootId: state.bootId,
        code: payload.code ?? null,
        detail: payload.message ?? null,
        requestId: payload.request_id ?? null,
      },
    );
  }

  async function forwardTelemetryNow(payload, node = {}) {
    let context = deviceContexts.get(payload.deviceId);

    if (!context) {
      context = createDeviceContext(payload.deviceId);
      deviceContexts.set(payload.deviceId, context);
    }

    const previousBootId = context.bootId ?? null;

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
    const nextConnectionState =
      telemetryResult?.after?.gatewayConnectionState ??
      telemetryResult?.before?.gatewayConnectionState ??
      "connected";
    context.lastGatewayConnectionState = nextConnectionState;

    if (previousBootId && payload.bootId && previousBootId !== payload.bootId) {
      removeBackfillState(payload.deviceId);
    }

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
    } else if (Date.now() - context.lastHeartbeatForwardedAt >= config.heartbeatMinIntervalMs) {
      emitPersistMessage("persist-heartbeat", payload.deviceId, {
        deviceId: payload.deviceId,
        timestamp: payload.timestamp,
        bootId: payload.bootId,
        firmwareVersion: payload.firmwareVersion,
        hardwareId: payload.hardwareId,
      });
      context.lastState = payload.state;
      context.lastHeartbeatForwardedAt = Date.now();
    } else {
      context.lastState = payload.state;
    }

    if (nextConnectionState === "connected") {
      ensureBackfillState(context, payload);
    }
  }

  function forwardTelemetry(payload, node = {}) {
    return queueLiveDeviceTask(payload.deviceId, () => forwardTelemetryNow(payload, node));
  }

  function handleHistoryRecordNow(event) {
    const deviceId = event.device_id;
    const state = historySyncByDevice.get(deviceId);

    if (!state || state.status !== "buffering_page") {
      logBackfill("dropping history record outside active page buffer", {
        deviceId: deviceId ?? null,
        status: state?.status ?? null,
        sequence: event.record?.sequence ?? null,
        kind: event.record?.kind ?? null,
      });
      return;
    }

    if (!state.requestId && event.request_id) {
      state.requestId = event.request_id;
      logBackfill("bound history request", {
        deviceId: deviceId ?? null,
        requestId: state.requestId,
      });
    }

    if (event.request_id !== state.requestId) {
      logBackfill("dropping history record for stale request", {
        deviceId: deviceId ?? null,
        expectedRequestId: state.requestId ?? null,
        requestId: event.request_id ?? null,
        sequence: event.record?.sequence ?? null,
      });
      return;
    }

    const sequence = event.record?.sequence;
    if (!Number.isFinite(sequence) || sequence <= 0) {
      logBackfill("dropping malformed history record without valid sequence", {
        deviceId: deviceId ?? null,
        requestId: event.request_id ?? null,
        kind: event.record?.kind ?? null,
        sequence: sequence ?? null,
      });
      return;
    }

    if (state.recordSequences.has(sequence)) {
      logBackfill("dropping duplicate history record within active page buffer", {
        deviceId: deviceId ?? null,
        requestId: event.request_id ?? null,
        sequence,
        kind: event.record?.kind ?? null,
      });
      return;
    }

    state.recordSequences.add(sequence);
    state.records.push(event.record);
  }

  function handleHistoryRecord(event) {
    const deviceId = event?.device_id;
    if (!deviceId) {
      return Promise.resolve();
    }

    return queueHistoryDeviceTask(deviceId, () => handleHistoryRecordNow(event));
  }

  function handleHistorySyncComplete(event) {
    const deviceId = event?.payload?.device_id;
    if (!deviceId) {
      return Promise.resolve();
    }

    const state = historySyncByDevice.get(deviceId);
    if (state) {
      state.completionPending = true;
    }

    return queueHistoryDeviceTask(deviceId, () => handleHistorySyncCompleteNow(event));
  }

  function handleHistoryError(event) {
    const deviceId = event?.payload?.device_id;
    if (!deviceId) {
      return Promise.resolve();
    }

    return queueHistoryDeviceTask(deviceId, () => handleHistoryErrorNow(event));
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

  function handleNodeConnectionStateNow(event) {
    const node = event.node ?? {};
    const peripheralInfo = describeNode(node);
    const label =
      node.localName ?? node.local_name ?? node.peripheralId ?? node.peripheral_id ?? "a BLE node";
    const connectionState =
      event.gatewayConnectionState ?? event.gateway_connection_state ?? "disconnected";

    if (connectionState === "connecting" || connectionState === "reconnecting") {
      const knownDeviceId =
        node.knownDeviceId ??
        node.known_device_id ??
        runtimeServer.resolveKnownDeviceId(peripheralInfo) ??
        null;
      if (knownDeviceId) {
        const context = deviceContexts.get(knownDeviceId) ?? createDeviceContext(knownDeviceId);
        context.lastGatewayConnectionState = connectionState;
        context.peripheralId = peripheralInfo.peripheralId ?? context.peripheralId ?? null;
        context.address = peripheralInfo.address ?? context.address ?? null;
        context.advertisedName = peripheralInfo.localName ?? context.advertisedName ?? null;
        context.rssi = peripheralInfo.rssi ?? context.rssi ?? null;
        deviceContexts.set(knownDeviceId, context);
      }
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
      const knownDeviceId =
        node.knownDeviceId ??
        node.known_device_id ??
        runtimeServer.resolveKnownDeviceId(peripheralInfo) ??
        null;
      const eventBootId = event.bootId ?? event.boot_id ?? null;

      if (knownDeviceId) {
        const context = deviceContexts.get(knownDeviceId) ?? createDeviceContext(knownDeviceId);
        context.lastGatewayConnectionState = "connected";
        context.bootId = eventBootId ?? context.bootId ?? null;
        context.peripheralId = peripheralInfo.peripheralId ?? context.peripheralId ?? null;
        context.address = peripheralInfo.address ?? context.address ?? null;
        context.advertisedName = peripheralInfo.localName ?? context.advertisedName ?? null;
        context.rssi = peripheralInfo.rssi ?? context.rssi ?? null;
        deviceContexts.set(knownDeviceId, context);

        if (context.bootId) {
          ensureBackfillState(context, {
            deviceId: knownDeviceId,
            bootId: context.bootId,
            firmwareVersion: context.firmwareVersion,
            hardwareId: context.hardwareId,
          });
        } else {
          logBackfill("connected event missing boot metadata; history sync deferred", {
            deviceId: knownDeviceId,
            peripheralId: peripheralInfo.peripheralId ?? null,
            knownDeviceId,
            eventBootId,
          });
        }
      }

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
      removeBackfillState(knownDeviceId);
    }
    if (context) {
      context.lastGatewayConnectionState = "disconnected";
      syncBackfillContext(context, null);
    }
  }

  function handleNodeConnectionState(event) {
    const node = event.node ?? {};
    const peripheralInfo = describeNode(node);
    const knownDeviceId =
      node.knownDeviceId ??
      node.known_device_id ??
      runtimeServer.resolveKnownDeviceId(peripheralInfo) ??
      null;

    if (!knownDeviceId) {
      handleNodeConnectionStateNow(event);
      return Promise.resolve();
    }

    const historyState = historySyncByDevice.get(knownDeviceId);
    const enqueueConnectionState =
      historyState?.completionPending === true
        ? queueHistoryDeviceTask
        : queueLiveDeviceTask;

    return enqueueConnectionState(knownDeviceId, () => handleNodeConnectionStateNow(event));
  }

  return {
    forwardTelemetry,
    handleHistoryRecord,
    handleHistorySyncComplete,
    handleHistoryError,
    handleNodeDiscovered,
    handleNodeConnectionState,
  };
}
