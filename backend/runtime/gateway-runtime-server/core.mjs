import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_KNOWN_NODE_DIR,
  nowIso,
  jsonResponse,
  formatSseEvent,
  latestTimestamp,
  telemetryFreshnessFromTimestamp,
  healthStatusFromRuntime,
  sortDevices,
  emptyOtaRuntimeState,
  emptyReconnectRuntimeState,
} from "./utils.mjs";

import { createKnownNodeStore } from "./persistence.mjs";
import { createRequestHandler } from "./routes.mjs";
import { createProjectionHelpers } from "./projection.mjs";
import { createDiscoveryStore } from "./discovery-store.mjs";
import { createManualScanManager } from "./manual-scan.mjs";
import { createMetadataManager } from "./metadata-manager.mjs";

export function createGatewayRuntimeServer({
  apiBaseUrl,
  runtimeHost,
  runtimePort,
  knownNodesPath = path.join(DEFAULT_KNOWN_NODE_DIR, "gateway-known-nodes.json"),
  onControlCommand = null,
  verbose = false,
}) {
  const sessionId = crypto.randomUUID();
  const metadataByDeviceId = new Map();
  const runtimeByDeviceId = new Map();
  const knownNodesByDeviceId = new Map();
  const suppressedDeviceIds = new Set();
  const deviceIdByPeripheralId = new Map();
  const streamClients = new Set();

  const discoveryStore = createDiscoveryStore({ nowIso });
  const { listDiscoveries, removeDiscoveryEntries, upsertDiscovery } = discoveryStore;

  const manualScanManager = createManualScanManager();
  const getManualScanPayload = manualScanManager.getPayload;

  let availableAdapters = [];
  let knownNodesWriteTimer = null;
  let knownNodesPersistPromise = null;
  let runtimeIssue = null;
  let server = null;

  const gatewayState = {
    hostname: os.hostname(),
    mode: "reference-ble-node-gateway",
    sessionId,
    adapterState: "unknown",
    scanState: "idle",
    scanReason: null,
    connectedNodeCount: 0,
    reconnectingNodeCount: 0,
    knownNodeCount: 0,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    lastAdvertisementAt: null,
  };

  function debug(message, details) {
    if (!verbose) {
      return;
    }

    if (details !== undefined) {
      console.log(`[gateway-runtime] ${message}`, details);
      return;
    }

    console.log(`[gateway-runtime] ${message}`);
  }

  function touchGatewayState(patch = {}) {
    Object.assign(gatewayState, patch, { updatedAt: nowIso() });
    gatewayState.knownNodeCount = knownNodesByDeviceId.size;
    gatewayState.connectedNodeCount = Array.from(runtimeByDeviceId.values()).filter(
      (node) => node.gatewayConnectionState === "connected",
    ).length;
    gatewayState.reconnectingNodeCount = Array.from(runtimeByDeviceId.values()).filter(
      (node) =>
        node.gatewayConnectionState === "reconnecting" ||
        node.gatewayConnectionState === "connecting",
    ).length;
  }

  const knownNodeStore = createKnownNodeStore({
    knownNodesPath,
    knownNodesByDeviceId,
    deviceIdByPeripheralId,
    runtimeByDeviceId,
    emptyOtaRuntimeState,
    emptyReconnectRuntimeState,
    touchGatewayState,
    nowIso,
  });
  const loadKnownNodes = () => knownNodeStore.loadKnownNodes();
  const persistKnownNodes = () => knownNodeStore.persistKnownNodes();
  const scheduleKnownNodesPersist = () => knownNodeStore.schedulePersist();

  function broadcast(event, payload) {
    const body = formatSseEvent(event, payload);

    for (const client of streamClients) {
      client.write(body);
    }
  }

  function broadcastGatewayStatus() {
    touchGatewayState();
    broadcast("gateway-status", {
      ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
      gateway: gatewayState,
      error: runtimeIssue ?? undefined,
    });
  }

  const metadataManager = createMetadataManager({
    apiBaseUrl,
    metadataByDeviceId,
    debug,
  });
  const { refreshMetadata } = metadataManager;

  async function readJsonRequest(request) {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  // persistence helpers handled via createKnownNodeStore()

  const projection = createProjectionHelpers({
    metadataByDeviceId,
    runtimeByDeviceId,
    knownNodesByDeviceId,
    deviceIdByPeripheralId,
    gatewayState,
    broadcast,
    broadcastGatewayStatus,
    touchGatewayState,
    nowIso,
    healthStatusFromRuntime,
    telemetryFreshnessFromTimestamp,
    emptyOtaRuntimeState,
    emptyReconnectRuntimeState,
  });

  const {
    mergeDevice,
    emitDevice,
    upsertKnownNode,
    resolveKnownDeviceIdByDiscovery,
    updateRuntimeNode,
    normalizeIdleConnectionStates,
    inspectNodeConnection,
  } = projection;

  async function getDevicesPayload() {
    await refreshMetadata();

    const deviceIds = new Set([
      ...knownNodesByDeviceId.keys(),
      ...runtimeByDeviceId.keys(),
      ...metadataByDeviceId.keys(),
    ]);

    return {
      ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
      gateway: gatewayState,
      error: runtimeIssue ?? undefined,
      devices: sortDevices(
        Array.from(deviceIds)
          .filter((deviceId) => !suppressedDeviceIds.has(deviceId))
          .map((deviceId) => mergeDevice(deviceId)),
      ),
    };
  }

  const handleRequest = createRequestHandler({
    gatewayState,
    runtimeIssue,
    availableAdapters,
    streamClients,
    getDevicesPayload,
    getManualScanPayload,
    onControlCommand,
    touchGatewayState,
    broadcastGatewayStatus,
    readJsonRequest,
    listDiscoveries,
  });

  return {
    async start() {
      await knownNodeStore.loadKnownNodes();

      if (server) {
        return;
      }

      server = http.createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          console.error("[gateway-runtime] request failed", error);
          jsonResponse(response, 500, { ok: false, error: "Gateway runtime failed." });
        });
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(runtimePort, runtimeHost, () => {
          server?.off("error", reject);
          resolve();
        });
      });

      debug(`runtime API listening on http://${runtimeHost}:${runtimePort}`);
    },

    async stop() {
      knownNodeStore.cancelPersist();
      await knownNodeStore.persistKnownNodes();

      for (const client of streamClients) {
        client.end();
      }
      streamClients.clear();

      if (!server) {
        return;
      }

      const currentServer = server;
      server = null;

      await new Promise((resolve, reject) => {
        currentServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },

    setAdapterState(state) {
      touchGatewayState({ adapterState: state });

      if (state === "poweredOn") {
        for (const deviceId of knownNodesByDeviceId.keys()) {
          updateRuntimeNode(deviceId, {
            gatewayConnectionState: "disconnected",
          });
          emitDevice(deviceId);
        }
      } else {
        for (const [deviceId, runtime] of runtimeByDeviceId.entries()) {
          runtimeByDeviceId.set(deviceId, {
            ...runtime,
            gatewayConnectionState: "unreachable",
            gatewayLastDisconnectedAt: nowIso(),
            gatewayDisconnectReason: `adapter-${state}`,
            updatedAt: nowIso(),
          });
          emitDevice(deviceId);
        }
      }

      broadcastGatewayStatus();
    },

    setGatewayIssue(issue) {
      runtimeIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
      broadcastGatewayStatus();
    },

    setAvailableAdapters(adapters) {
      availableAdapters = Array.isArray(adapters) ? adapters : [];
      broadcast("gateway-adapters", { adapters: availableAdapters });
      broadcastGatewayStatus();
    },

    setScanState(scanState, scanReason = null) {
      touchGatewayState({
        scanState,
        scanReason: scanState === "scanning" ? scanReason : null,
      });

      if (scanState !== "scanning") {
        normalizeIdleConnectionStates();
      }

      broadcastGatewayStatus();
    },

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
        reconnectAttempt:
          reconnectAttempt ?? existingRuntime?.reconnectAttempt ?? 0,
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
          reconnectAttempt ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttempt ??
          0,
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
          patch.otaLastPhase !== undefined
            ? patch.otaLastPhase
            : previous.otaLastPhase ?? null,
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

    setManualScanState(config) {
      manualScanManager.setState(config);
    },

    upsertManualScanCandidate(candidate) {
      manualScanManager.upsertCandidate(candidate);
    },

    getManualScanPayload,

    resolveKnownDeviceId(input) {
      return resolveKnownDeviceIdByDiscovery(input);
    },
    inspectNodeConnection,
  };
}
