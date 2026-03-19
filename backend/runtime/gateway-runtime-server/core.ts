// @ts-nocheck
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_KNOWN_NODE_DIR,
  nowIso,
  jsonResponse,
  formatSseEvent,
  telemetryFreshnessFromTimestamp,
  healthStatusFromRuntime,
  sortDevices,
  emptyOtaRuntimeState,
  emptyReconnectRuntimeState,
} from "./utils.js";

import { createKnownNodeStore } from "./persistence.js";
import { createRequestHandler } from "./routes.js";
import { createProjectionHelpers } from "./projection.js";
import { createDiscoveryStore } from "./discovery-store.js";
import { createManualScanManager } from "./manual-scan.js";
import { createMetadataManager } from "./metadata-manager.js";
import { createRuntimeDeviceEventController } from "./runtime-events.js";

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
    getRuntimeIssue: () => runtimeIssue,
    getAvailableAdapters: () => availableAdapters,
    streamClients,
    getDevicesPayload,
    getManualScanPayload,
    onControlCommand,
    touchGatewayState,
    broadcastGatewayStatus,
    readJsonRequest,
    listDiscoveries,
  });

  const runtimeEvents = createRuntimeDeviceEventController({
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

    setManualScanState(config) {
      manualScanManager.setState(config);
    },

    upsertManualScanCandidate(candidate) {
      manualScanManager.upsertCandidate(candidate);
    },

    getManualScanPayload,

    getGatewayState() {
      touchGatewayState();
      return { ...gatewayState };
    },

    getAvailableAdapters() {
      return [...availableAdapters];
    },

    getRuntimeNode(deviceId) {
      const runtime = runtimeByDeviceId.get(deviceId);
      return runtime ? { ...runtime } : null;
    },

    getRuntimeNodes() {
      return Array.from(runtimeByDeviceId.entries()).map(([deviceId, runtime]) => ({
        deviceId,
        ...runtime,
      }));
    },

    resolveKnownDeviceId(input) {
      return resolveKnownDeviceIdByDiscovery(input);
    },

    ...runtimeEvents,
    inspectNodeConnection,
  };
}
