import { sendRequestToDesktop as defaultSendRequestToDesktop } from "./windows-winrt-gateway-desktop-ipc.mjs";

const DEFAULT_HISTORY_PAGE_SIZE = 250;
const DEFAULT_AUTO_START_DELAY_MS = 0;

function connectionKeyForNode(node = {}) {
  return node.peripheralId ?? node.peripheral_id ?? node.id ?? null;
}

function knownDeviceIdForNode(node = {}) {
  return node.knownDeviceId ?? node.known_device_id ?? null;
}

function localNameForNode(node = {}) {
  return node.localName ?? node.local_name ?? null;
}

function normalizeHistoryRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  if (record.kind === "motion") {
    if (
      typeof record.sequence !== "number" ||
      typeof record.state !== "string" ||
      typeof record.timestamp !== "number"
    ) {
      return null;
    }

    return {
      kind: "motion",
      sequence: record.sequence,
      state: record.state,
      delta: record.delta ?? null,
      timestamp: record.timestamp,
      bootId: record.boot_id ?? record.bootId,
      firmwareVersion: record.firmware_version ?? record.firmwareVersion,
      hardwareId: record.hardware_id ?? record.hardwareId,
    };
  }

  if (record.kind === "node-log") {
    if (
      typeof record.sequence !== "number" ||
      typeof record.level !== "string" ||
      typeof record.code !== "string" ||
      typeof record.message !== "string"
    ) {
      return null;
    }

    return {
      kind: "node-log",
      sequence: record.sequence,
      level: record.level,
      code: record.code,
      message: record.message,
      timestamp: record.timestamp ?? undefined,
      bootId: record.boot_id ?? record.bootId,
      firmwareVersion: record.firmware_version ?? record.firmwareVersion,
      hardwareId: record.hardware_id ?? record.hardwareId,
      metadata:
        record.metadata && typeof record.metadata === "object" ? record.metadata : undefined,
    };
  }

  return null;
}

function normalizeHistorySyncCompletePayload(payload) {
  const deviceId = payload?.device_id ?? payload?.deviceId;
  const latestSequence = payload?.latest_sequence ?? payload?.latestSequence;
  const highWaterSequence = payload?.high_water_sequence ?? payload?.highWaterSequence;
  const sentCount = payload?.sent_count ?? payload?.sentCount;
  const hasMore = payload?.has_more ?? payload?.hasMore;

  if (
    typeof deviceId !== "string" ||
    typeof latestSequence !== "number" ||
    typeof highWaterSequence !== "number" ||
    typeof sentCount !== "number" ||
    typeof hasMore !== "boolean"
  ) {
    return null;
  }

  return {
    deviceId,
    latestSequence,
    highWaterSequence,
    sentCount,
    hasMore,
    overflowed: payload?.overflowed === true,
    droppedCount:
      typeof payload?.dropped_count === "number" ? payload.dropped_count : payload?.droppedCount,
  };
}

function buildPersistPayload(deviceId, session, completion) {
  return {
    deviceId,
    bootId:
      session.records
        .find((record) => typeof record.bootId === "string" && record.bootId.length > 0)
        ?.bootId ?? undefined,
    records: session.records,
    ackSequence: completion.latestSequence,
    overflowDetectedAt: completion.overflowed ? new Date().toISOString() : undefined,
  };
}

function isHistorySyncFailureMessage(message) {
  return (
    message === "Ignoring history sync request until the active session is healthy." ||
    message.startsWith("History replay start failed") ||
    message.startsWith("History replay ack failed")
  );
}

function normalizeFailureEvent(event = {}) {
  const message = typeof event.message === "string" ? event.message : null;

  if (!message || !isHistorySyncFailureMessage(message)) {
    return null;
  }

  const details = event.details && typeof event.details === "object" ? event.details : {};
  const detailError =
    typeof details.error === "string"
      ? details.error
      : typeof details.recoveryError === "string"
        ? details.recoveryError
        : null;

  return {
    connectionId: details.peripheralId ?? null,
    deviceId: details.knownDeviceId ?? null,
    address: details.address ?? null,
    localName: details.localName ?? null,
    error: detailError ? `${message} ${detailError}` : message,
  };
}

export function createHistorySyncCoordinator({
  debug = () => {},
  sendSidecarCommand,
  sendRequestToDesktop = defaultSendRequestToDesktop,
  onHistorySyncStateChanged = () => {},
  pageSize = DEFAULT_HISTORY_PAGE_SIZE,
  autoStartDelayMs = DEFAULT_AUTO_START_DELAY_MS,
  scheduleAutoStart = globalThis.setTimeout,
  clearScheduledAutoStart = globalThis.clearTimeout,
}) {
  const sessions = new Map();
  const autoStartTimers = new Map();

  function clearAutoStartTimer(connectionId) {
    if (!connectionId || !autoStartTimers.has(connectionId)) {
      return;
    }

    clearScheduledAutoStart(autoStartTimers.get(connectionId));
    autoStartTimers.delete(connectionId);
  }

  function publishState(details = {}, state, error = null) {
    if (!details.deviceId && !details.connectionId) {
      return;
    }

    onHistorySyncStateChanged({
      deviceId: details.deviceId ?? null,
      knownDeviceId: details.deviceId ?? null,
      peripheralId: details.connectionId ?? null,
      address: details.address ?? null,
      localName: details.localName ?? null,
      state,
      error,
    });
  }

  function buildSessionDetails(node = {}, existing = null) {
    const connectionId = connectionKeyForNode(node) ?? existing?.connectionId ?? null;

    return {
      connectionId,
      deviceId: knownDeviceIdForNode(node) ?? existing?.deviceId ?? null,
      address: node.address ?? existing?.address ?? null,
      localName: localNameForNode(node) ?? existing?.localName ?? null,
      records: existing?.records ?? [],
      inFlight: existing?.inFlight ?? false,
      parseFailed: existing?.parseFailed ?? false,
    };
  }

  async function persistHistoryBatch(deviceId, payload) {
    await sendRequestToDesktop(
      {
        type: "persist-device-backfill",
        deviceId,
        payload,
      },
      { debug },
    );
  }

  function requestHistorySyncForNode(node = {}, afterSequence = 0) {
    const existing = sessions.get(connectionKeyForNode(node));
    const nextSession = buildSessionDetails(node, existing);

    if (!nextSession.connectionId) {
      debug("skipped history sync start because the node had no connection key", node);
      return false;
    }

    if (existing?.inFlight) {
      return false;
    }

    clearAutoStartTimer(nextSession.connectionId);
    sessions.set(nextSession.connectionId, {
      ...nextSession,
      records: [],
      inFlight: true,
      parseFailed: false,
    });
    publishState(nextSession, "syncing");

    sendSidecarCommand("start_history_sync", {
      connection_id: nextSession.connectionId,
      after_sequence: afterSequence,
      max_records: pageSize,
    });
    return true;
  }

  function handleNodeConnected(node = {}) {
    const connectionId = connectionKeyForNode(node);

    if (!connectionId) {
      debug("skipped delayed history sync start because the node had no connection key", node);
      return;
    }

    clearAutoStartTimer(connectionId);

    if (autoStartDelayMs <= 0) {
      requestHistorySyncForNode(node);
      return;
    }

    autoStartTimers.set(
      connectionId,
      scheduleAutoStart(() => {
        autoStartTimers.delete(connectionId);
        requestHistorySyncForNode(node);
      }, autoStartDelayMs),
    );
  }

  function handleNodeDisconnected(event = {}) {
    const node = event.node ?? {};
    const connectionId = connectionKeyForNode(node);
    const existing = connectionId ? sessions.get(connectionId) : null;
    const details = buildSessionDetails(node, existing);

    if (connectionId) {
      clearAutoStartTimer(connectionId);
      sessions.delete(connectionId);
    }

    publishState(details, "idle");
  }

  function handleHistoryRecord(event = {}) {
    const connectionId = connectionKeyForNode(event.node ?? {});
    const record = normalizeHistoryRecord(event.record);

    if (!connectionId || !record) {
      debug("ignored invalid history record event", event);
      return;
    }

    const existing = sessions.get(connectionId) ?? null;
    const current = {
      ...buildSessionDetails(event.node ?? {}, existing),
      deviceId: event.device_id ?? event.deviceId ?? existing?.deviceId ?? null,
      records: [...(existing?.records ?? []), record],
      inFlight: true,
      parseFailed: false,
    };

    sessions.set(connectionId, current);
  }

  function handleRuntimeLog(event = {}) {
    const failure = normalizeFailureEvent(event);

    if (!failure) {
      return;
    }

    const existing = failure.connectionId ? sessions.get(failure.connectionId) ?? null : null;
    const details = {
      connectionId: failure.connectionId ?? existing?.connectionId ?? null,
      deviceId: failure.deviceId ?? existing?.deviceId ?? null,
      address: failure.address ?? existing?.address ?? null,
      localName: failure.localName ?? existing?.localName ?? null,
    };

    if (failure.connectionId) {
      clearAutoStartTimer(failure.connectionId);
      sessions.delete(failure.connectionId);
    }

    publishState(details, "failed", failure.error);
  }

  async function handleHistorySyncComplete(event = {}) {
    const connectionId = connectionKeyForNode(event.node ?? {});
    const completion = normalizeHistorySyncCompletePayload(event.payload);

    if (!connectionId || !completion) {
      debug("ignored invalid history sync completion event", event);
      return;
    }

    const session = {
      ...buildSessionDetails(event.node ?? {}, sessions.get(connectionId) ?? null),
      deviceId: completion.deviceId,
    };

    clearAutoStartTimer(connectionId);

    if (session.records.length !== completion.sentCount) {
      debug("history sync page size mismatch; leaving firmware records unacked", {
        connectionId,
        expected: completion.sentCount,
        actual: session.records.length,
      });
      sessions.delete(connectionId);
      publishState(session, "failed", "History sync page mismatch. Use Refresh to retry.");
      return;
    }

    try {
      if (session.records.length > 0 || completion.overflowed) {
        await persistHistoryBatch(
          completion.deviceId,
          buildPersistPayload(completion.deviceId, session, completion),
        );
      }
    } catch (error) {
      sessions.delete(connectionId);
      publishState(
        session,
        "failed",
        error instanceof Error ? error.message : "Failed to persist history sync page.",
      );
      return;
    }

    if (completion.latestSequence > 0) {
      sendSidecarCommand("ack_history_sync", {
        connection_id: connectionId,
        sequence: completion.latestSequence,
        continue_after_sequence:
          completion.hasMore && completion.latestSequence < completion.highWaterSequence
            ? completion.latestSequence
            : undefined,
        max_records:
          completion.hasMore && completion.latestSequence < completion.highWaterSequence
            ? pageSize
            : undefined,
      });
    }

    if (completion.hasMore && completion.sentCount === 0) {
      debug(
        "history sync reported more data without sending records; stopping to avoid a replay loop",
        {
          connectionId,
          latestSequence: completion.latestSequence,
          highWaterSequence: completion.highWaterSequence,
        },
      );
      sessions.delete(connectionId);
      publishState(session, "failed", "History sync stalled before the next page could load.");
      return;
    }

    if (completion.hasMore && completion.latestSequence < completion.highWaterSequence) {
      sessions.set(connectionId, {
        ...session,
        records: [],
        inFlight: true,
        parseFailed: false,
      });
      publishState(session, "syncing");
      return;
    }

    sessions.delete(connectionId);
    publishState(session, "idle");
  }

  return {
    handleNodeConnected,
    handleNodeDisconnected,
    handleHistoryRecord,
    handleHistorySyncComplete,
    handleRuntimeLog,
    requestHistorySyncForNode,
  };
}
