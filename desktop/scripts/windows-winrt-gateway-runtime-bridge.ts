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
  nextEligibleAt,
}) {
  return {
    deviceId,
    bootId,
    firmwareVersion,
    hardwareId,
    status: "waiting_for_stable_live",
    requestedAfterSequence: null,
    latestSequence: 0,
    highWaterSequence: 0,
    records: [],
    nextEligibleAt,
    timerHandle: null,
    timerToken: 0,
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
  const historySyncStabilityWindowMs =
    config.historySyncStabilityWindowMs ?? config.historySyncDelayMs ?? 5_000;
  const historySyncPageSize = config.historySyncPageSize ?? 3;
  const historySyncInterPageDelayMs = config.historySyncInterPageDelayMs ?? 2_000;
  const deviceContexts = new Map();
  const pendingNodeLogs = new Map();
  const liveTaskChains = new Map();
  const historyTaskChains = new Map();
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
    context.backfillNextEligibleAt = state?.nextEligibleAt ?? null;
    context.backfillPausedReason = state?.pausedReason ?? null;
  }

  function clearBackfillTimer(state) {
    if (!state?.timerHandle) {
      return;
    }

    clearTimeoutImpl(state.timerHandle);
    state.timerHandle = null;
  }

  function removeBackfillState(deviceId) {
    const existing = historySyncByDevice.get(deviceId);

    if (existing) {
      clearBackfillTimer(existing);
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
    clearBackfillTimer(state);
    setBackfillStatus(context, state, "paused_after_error", {
      records: [],
      pausedReason: reason,
      nextEligibleAt: null,
    });
    logBackfill(reason, details);
  }

  function completeBackfill(context, state, details = undefined) {
    clearBackfillTimer(state);
    setBackfillStatus(context, state, "complete", {
      records: [],
      pausedReason: null,
      nextEligibleAt: null,
    });
    if (details) {
      logBackfill("history sync complete", details);
    }
  }

  function scheduleBackfillPump(deviceId, delayMs = 0) {
    const state = historySyncByDevice.get(deviceId);

    if (!state || state.status === "paused_after_error" || state.status === "complete") {
      return;
    }

    clearBackfillTimer(state);
    state.timerToken += 1;
    const token = state.timerToken;

    if (delayMs <= 0) {
      Promise.resolve().then(() => {
        const current = historySyncByDevice.get(deviceId);
        if (!current || current.timerToken !== token) {
          return;
        }
        current.timerHandle = null;
        void queueHistoryDeviceTask(deviceId, () => pumpBackfillNow(deviceId));
      });
      return;
    }

    state.timerHandle = setTimeoutImpl(() => {
      const current = historySyncByDevice.get(deviceId);
      if (!current || current.timerToken !== token) {
        return;
      }
      current.timerHandle = null;
      void queueHistoryDeviceTask(deviceId, () => pumpBackfillNow(deviceId));
    }, delayMs);
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
        nextEligibleAt: nowFn() + historySyncStabilityWindowMs,
      });
      historySyncByDevice.set(payload.deviceId, state);
      syncBackfillContext(context, state);
      logBackfill("waiting for stable live session before history sync", {
        deviceId: payload.deviceId,
        bootId: payload.bootId,
        waitMs: historySyncStabilityWindowMs,
      });
    } else {
      state.firmwareVersion = payload.firmwareVersion ?? state.firmwareVersion ?? null;
      state.hardwareId = payload.hardwareId ?? state.hardwareId ?? null;
    }

    if (context.lastTelemetryConnectionState === "connected") {
      const delayMs = Math.max(0, (state.nextEligibleAt ?? nowFn()) - nowFn());
      scheduleBackfillPump(payload.deviceId, delayMs);
    }

    return state;
  }

  async function requestHistoryPage(context, state) {
    if (state.requestedAfterSequence == null) {
      const syncResponse = await fetchDesktopJson(
        `/api/device-sync/${encodeURIComponent(state.deviceId)}?bootId=${encodeURIComponent(state.bootId)}`,
      );
      const historySyncState = syncResponse?.historySyncState ?? {};
      state.requestedAfterSequence = historySyncState.lastAckedHistorySequence ?? 0;
      state.latestSequence = state.requestedAfterSequence;
      state.highWaterSequence = state.requestedAfterSequence;
    }

    setBackfillStatus(context, state, "buffering_page", {
      records: [],
      pausedReason: null,
      nextEligibleAt: null,
    });

    logBackfill("requesting history sync", {
      deviceId: state.deviceId,
      bootId: state.bootId,
      afterSequence: state.requestedAfterSequence,
      maxRecords: historySyncPageSize,
    });

    await sendSidecarCommand({
      type: "begin_history_sync",
      device_id: state.deviceId,
      after_sequence: state.requestedAfterSequence,
      max_records: historySyncPageSize,
    });
  }

  async function pumpBackfillNow(deviceId) {
    const state = historySyncByDevice.get(deviceId);
    const context = deviceContexts.get(deviceId);

    if (!state || !context) {
      return;
    }

    if (
      context.lastTelemetryConnectionState !== "connected" ||
      context.bootId !== state.bootId
    ) {
      return;
    }

    const now = nowFn();

    if (state.status === "waiting_for_stable_live") {
      if ((state.nextEligibleAt ?? now) > now) {
        scheduleBackfillPump(deviceId, state.nextEligibleAt - now);
        return;
      }

      setBackfillStatus(context, state, "requesting_page", {
        nextEligibleAt: now,
      });
    }

    if (state.status !== "requesting_page") {
      return;
    }

    if ((state.nextEligibleAt ?? now) > now) {
      scheduleBackfillPump(deviceId, state.nextEligibleAt - now);
      return;
    }

    try {
      await requestHistoryPage(context, state);
    } catch (error) {
      pauseBackfill(context, state, "history sync request failed", {
        deviceId: state.deviceId,
        bootId: state.bootId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
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
      logBackfill("history sync recovered additional records from malformed payload", {
        deviceId,
        bootId: state.bootId,
        expectedRecordCount,
        actualRecordCount: records.length,
      });
    }

    setBackfillStatus(context, state, "persisting_page", {
      records: [],
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
          ...(payload.overflowed ? { overflowDetectedAt: new Date().toISOString() } : {}),
        }),
      });

      const provenAckSequence = result?.historySyncState?.lastAckedHistorySequence ?? 0;

      logBackfill("persisted backfill batch", {
        deviceId,
        bootId: state.bootId,
        ackSequence: payload.latest_sequence ?? 0,
        recordCount: records.length,
        provenAckSequence,
      });

      setBackfillStatus(context, state, "acking_page", {
        pausedReason: null,
      });

      await sendSidecarCommand({
        type: "acknowledge_history_sync",
        device_id: deviceId,
        sequence: provenAckSequence,
      });

      const noProgress = provenAckSequence <= (state.requestedAfterSequence ?? 0);
      const shouldContinue =
        payload.has_more === true ||
        (provenAckSequence < (payload.latest_sequence ?? 0) && !noProgress);

      if (!shouldContinue) {
        completeBackfill(context, state);
        if (provenAckSequence < (payload.latest_sequence ?? 0)) {
          logBackfill("history sync stopped after no forward progress", {
            deviceId,
            bootId: state.bootId,
            requestedAfterSequence: state.requestedAfterSequence,
            provenAckSequence,
            latestSequence: payload.latest_sequence ?? 0,
          });
        }
        return;
      }

      setBackfillStatus(context, state, "requesting_page", {
        requestedAfterSequence: provenAckSequence,
        nextEligibleAt: nowFn() + historySyncInterPageDelayMs,
        pausedReason: null,
      });

      logBackfill("scheduling next history sync page", {
        deviceId,
        bootId: state.bootId,
        afterSequence: provenAckSequence,
        highWaterSequence: payload.high_water_sequence ?? 0,
        hasMore: payload.has_more ?? false,
        maxRecords: historySyncPageSize,
        waitMs: historySyncInterPageDelayMs,
      });

      scheduleBackfillPump(deviceId, historySyncInterPageDelayMs);
    } catch (error) {
      pauseBackfill(context, state, "history sync persistence failed", {
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
    const previousConnectionState = context.lastTelemetryConnectionState;
    context.lastTelemetryConnectionState = nextConnectionState;

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
      const state = ensureBackfillState(context, payload);
      if (
        state &&
        previousConnectionState !== "connected" &&
        state.status === "waiting_for_stable_live"
      ) {
        scheduleBackfillPump(payload.deviceId, Math.max(0, (state.nextEligibleAt ?? nowFn()) - nowFn()));
      }
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
      removeBackfillState(knownDeviceId);
    }
    if (context) {
      context.lastTelemetryConnectionState = "disconnected";
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
    handleNodeDiscovered,
    handleNodeConnectionState,
  };
}
