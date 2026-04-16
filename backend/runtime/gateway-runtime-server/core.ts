import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type {
  BleAdapterSummary,
  GatewayRuntimeDevicesResponse,
  GatewayStatusSummary,
  ManualScanCandidateSummary,
  ManualScanState,
} from "@core/contracts";

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
  RECONNECT_DISCONNECT_GRACE_MS,
} from "./utils.js";

import { createKnownNodeStore } from "./persistence.js";
import { createRequestHandler } from "./routes.js";
import { createProjectionHelpers } from "./projection.js";
import { createRuntimeStateHelpers } from "./runtime-state.js";
import { createDiscoveryStore } from "./discovery-store.js";
import { createManualScanManager } from "./manual-scan.js";
import { createMetadataManager } from "./metadata-manager.js";
import { createRuntimeDeviceEventController } from "./runtime-events.js";
import { createGatewayServerHost } from "./server-host.js";
import type { DiscoveryLocator, KnownNode, RuntimeDeviceMetadata, RuntimeNode } from "./runtime-types.js";

type ManualScanPayload = {
  state: ManualScanState;
  pairingCandidateId?: string | null;
  error?: string | null;
  candidates?: ManualScanCandidateSummary[];
};

type GatewayControlCommandHandler =
  | ((command: unknown) => Promise<Record<string, unknown> | void>)
  | null;

export function createGatewayRuntimeServer({
  loadDevicesMetadata = async () => [],
  runtimeHost,
  runtimePort,
  knownNodesPath = path.join(DEFAULT_KNOWN_NODE_DIR, "gateway-known-nodes.json"),
  onControlCommand = null,
  reconnectDisconnectGraceMs = RECONNECT_DISCONNECT_GRACE_MS,
  verbose = false,
}: {
  loadDevicesMetadata?: () => Promise<RuntimeDeviceMetadata[]>;
  runtimeHost: string;
  runtimePort: number;
  knownNodesPath?: string;
  onControlCommand?: GatewayControlCommandHandler;
  reconnectDisconnectGraceMs?: number;
  verbose?: boolean;
}) {
  const sessionId = crypto.randomUUID();
  const metadataByDeviceId = new Map<string, RuntimeDeviceMetadata>();
  const runtimeByDeviceId = new Map<string, RuntimeNode>();
  const knownNodesByDeviceId = new Map<string, KnownNode>();
  const suppressedDeviceIds = new Set<string>();
  const deviceIdByPeripheralId = new Map<string, string>();
  const streamClients = new Set<http.ServerResponse>();

  const discoveryStore = createDiscoveryStore({ nowIso });
  const { listDiscoveries, removeDiscoveryEntries, upsertDiscovery } = discoveryStore;

  const manualScanManager = createManualScanManager();
  const getManualScanPayload = manualScanManager.getPayload;

  let availableAdapters: BleAdapterSummary[] = [];
  let runtimeIssue: string | null = null;
  const gatewayState: GatewayStatusSummary = {
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

  function debug(message: string, details?: unknown) {
    if (!verbose) {
      return;
    }

    if (details !== undefined) {
      console.log(`[gateway-runtime] ${message}`, details);
      return;
    }

    console.log(`[gateway-runtime] ${message}`);
  }

  function touchGatewayState(patch: Partial<GatewayStatusSummary> = {}) {
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

  function broadcast(event: string, payload: unknown) {
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
    loadDevicesMetadata,
    metadataByDeviceId,
    debug,
  });
  const { refreshMetadata } = metadataManager;

  async function readJsonRequest(request: http.IncomingMessage) {
    const chunks: Buffer[] = [];

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
    broadcast,
    nowIso,
    healthStatusFromRuntime,
    telemetryFreshnessFromTimestamp,
  });

  const { mergeDevice, emitDevice } = projection;

  const runtimeState = createRuntimeStateHelpers({
    metadataByDeviceId,
    runtimeByDeviceId,
    knownNodesByDeviceId,
    deviceIdByPeripheralId,
    touchGatewayState,
    emitDevice,
    mergeDevice,
    emptyOtaRuntimeState,
    emptyReconnectRuntimeState,
    nowIso,
  });

  const {
    upsertKnownNode,
    resolveKnownDeviceIdByDiscovery,
    updateRuntimeNode,
    normalizeIdleConnectionStates,
    inspectNodeConnection,
    getDeviceSummary,
    getDeviceSummaries,
  } = runtimeState;

  async function getDevicesPayload(): Promise<GatewayRuntimeDevicesResponse> {
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
    reconnectDisconnectGraceMs,
  });

  const serverHost = createGatewayServerHost({
    runtimeHost,
    runtimePort,
    handleRequest,
    debug,
  });

  return {
    async start() {
      await knownNodeStore.loadKnownNodes();
      await serverHost.start();
    },

    async stop() {
      runtimeEvents.cancelPendingReconnectDisconnects();
      knownNodeStore.cancelPersist();
      await knownNodeStore.persistKnownNodes();

      for (const client of streamClients) {
        client.end();
      }
      streamClients.clear();

      await serverHost.stop();
    },

    setAdapterState(state: string) {
      touchGatewayState({ adapterState: state });

      if (state === "poweredOn") {
        for (const deviceId of knownNodesByDeviceId.keys()) {
          updateRuntimeNode(deviceId, {
            gatewayConnectionState: "disconnected",
          });
          emitDevice(deviceId);
        }
      } else {
        runtimeEvents.cancelPendingReconnectDisconnects();
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

    setGatewayIssue(issue: string | null) {
      runtimeIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
      broadcastGatewayStatus();
    },

    setAvailableAdapters(adapters: BleAdapterSummary[]) {
      availableAdapters = Array.isArray(adapters) ? adapters : [];
      broadcast("gateway-adapters", { adapters: availableAdapters });
      broadcastGatewayStatus();
    },

    setScanState(scanState: string, scanReason: string | null = null) {
      touchGatewayState({
        scanState,
        scanReason: scanState === "scanning" ? scanReason : null,
      });

      if (scanState !== "scanning") {
        normalizeIdleConnectionStates();
      }

      broadcastGatewayStatus();
    },

    setManualScanState(config: ManualScanPayload) {
      manualScanManager.setState(config);
    },

    upsertManualScanCandidate(candidate: ManualScanCandidateSummary) {
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

    getRuntimeNode(deviceId: string) {
      const runtime = runtimeByDeviceId.get(deviceId);
      return runtime ? { ...runtime } : null;
    },

    getDeviceSummary,

    getDeviceSummaries,

    getRuntimeNodes() {
      return Array.from(runtimeByDeviceId.entries()).map(([deviceId, runtime]) => ({
        deviceId,
        ...runtime,
      }));
    },

    resolveKnownDeviceId(input: DiscoveryLocator) {
      return resolveKnownDeviceIdByDiscovery(input);
    },

    ...runtimeEvents,
    inspectNodeConnection,
  };
}
