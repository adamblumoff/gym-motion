import { sendRequestToDesktop as defaultSendRequestToDesktop } from "./windows-winrt-gateway-desktop-ipc.mjs";

const DEFAULT_HISTORY_PAGE_SIZE = 250;

function connectionKeyForNode(node = {}) {
  return node.peripheralId ?? node.peripheral_id ?? node.id ?? null;
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
    droppedCount: typeof payload?.dropped_count === "number" ? payload.dropped_count : payload?.droppedCount,
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

export function createHistorySyncCoordinator({
  debug = () => {},
  sendSidecarCommand,
  sendRequestToDesktop = defaultSendRequestToDesktop,
  pageSize = DEFAULT_HISTORY_PAGE_SIZE,
}) {
  const sessions = new Map();

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

  function startHistorySyncForNode(node = {}) {
    const connectionId = connectionKeyForNode(node);

    if (!connectionId) {
      debug("skipped history sync start because the node had no connection key", node);
      return;
    }

    const existing = sessions.get(connectionId);

    if (existing?.inFlight) {
      return;
    }

    sessions.set(connectionId, {
      connectionId,
      deviceId: node.knownDeviceId ?? node.known_device_id ?? existing?.deviceId ?? null,
      records: [],
      inFlight: true,
      parseFailed: false,
    });

    sendSidecarCommand("start_history_sync", {
      connection_id: connectionId,
      after_sequence: 0,
      max_records: pageSize,
    });
  }

  function handleNodeConnectionState(event = {}) {
    const connectionState =
      event.gatewayConnectionState ?? event.gateway_connection_state ?? "disconnected";
    const connectionId = connectionKeyForNode(event.node ?? {});

    if (!connectionId) {
      return;
    }

    if (connectionState === "connected") {
      startHistorySyncForNode(event.node ?? {});
      return;
    }

    if (connectionState === "disconnected") {
      sessions.delete(connectionId);
    }
  }

  function handleHistoryRecord(event = {}) {
    const connectionId = connectionKeyForNode(event.node ?? {});
    const record = normalizeHistoryRecord(event.record);

    if (!connectionId || !record) {
      debug("ignored invalid history record event", event);
      return;
    }

    const current = sessions.get(connectionId) ?? {
      connectionId,
      deviceId: event.device_id ?? event.deviceId ?? null,
      records: [],
      inFlight: true,
      parseFailed: false,
    };

    current.deviceId = event.device_id ?? event.deviceId ?? current.deviceId ?? null;
    current.records.push(record);
    sessions.set(connectionId, current);
  }

  async function handleHistorySyncComplete(event = {}) {
    const connectionId = connectionKeyForNode(event.node ?? {});
    const completion = normalizeHistorySyncCompletePayload(event.payload);

    if (!connectionId || !completion) {
      debug("ignored invalid history sync completion event", event);
      return;
    }

    const session = sessions.get(connectionId) ?? {
      connectionId,
      deviceId: completion.deviceId,
      records: [],
      inFlight: true,
      parseFailed: false,
    };
    session.deviceId = completion.deviceId;

    if (session.records.length !== completion.sentCount) {
      debug("history sync page size mismatch; leaving firmware records unacked", {
        connectionId,
        expected: completion.sentCount,
        actual: session.records.length,
      });
      sessions.delete(connectionId);
      return;
    }

    if (session.records.length > 0 || completion.overflowed) {
      await persistHistoryBatch(
        completion.deviceId,
        buildPersistPayload(completion.deviceId, session, completion),
      );
    }

    if (completion.latestSequence > 0) {
      sendSidecarCommand("ack_history_sync", {
        connection_id: connectionId,
        sequence: completion.latestSequence,
      });
    }

    if (completion.hasMore && completion.sentCount === 0) {
      debug("history sync reported more data without sending records; stopping to avoid a replay loop", {
        connectionId,
        latestSequence: completion.latestSequence,
        highWaterSequence: completion.highWaterSequence,
      });
      sessions.delete(connectionId);
      return;
    }

    if (completion.hasMore && completion.latestSequence < completion.highWaterSequence) {
      sessions.set(connectionId, {
        connectionId,
        deviceId: completion.deviceId,
        records: [],
        inFlight: true,
        parseFailed: false,
      });
      sendSidecarCommand("start_history_sync", {
        connection_id: connectionId,
        after_sequence: completion.latestSequence,
        max_records: pageSize,
      });
      return;
    }

    sessions.delete(connectionId);
  }

  return {
    handleNodeConnectionState,
    handleHistoryRecord,
    handleHistorySyncComplete,
  };
}
