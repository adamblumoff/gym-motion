import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  DesktopSnapshot,
  GatewayStatusSummary,
} from "@core/contracts";
import { mergeGatewayDeviceUpdate } from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";
import { app } from "electron";
import { hasMotionRollupTables, listDevices, rebuildMotionRollups } from "../../backend/data";
import { getDb } from "../../backend/data/db";

import { createDesktopApiServer } from "./desktop-api-server";
import {
  mergeRuntimeDeviceIntoGatewaySnapshot,
} from "./gateway-snapshot";
import type { PreferencesStore } from "./preferences-store";
import {
  matchesApprovedNodeRule,
  reconcileApprovedNodeRule,
  createNodeIdentity,
} from "./setup-selection";
import {
  applyAutoAdapterSelection,
  deriveAdapterIssue,
} from "./managed-gateway-runtime/adapters";
import {
  createEmptySetupState,
  createEmptySnapshot,
  liveStatusFor,
} from "./managed-gateway-runtime/snapshot";
import { pruneForgottenDevicesFromSnapshot } from "./managed-gateway-runtime/approved-node-prune";
import {
  dedupeApprovedNodes,
  normalizeApprovedNodes,
} from "./managed-gateway-runtime/setup-state";
import {
  type ManagedGatewayRuntime,
  type ManualScanPayload,
} from "./managed-gateway-runtime/common";
import type { GatewayChildRuntimeMessage } from "./managed-gateway-runtime/gateway-child-ipc";
import { createRuntimeBridge } from "./managed-gateway-runtime/runtime-bridge";
import { createRuntimeLifecycle } from "./managed-gateway-runtime/lifecycle";
import { createOperatorIntents } from "./managed-gateway-runtime/operator-intents";
import { createRuntimeSync } from "./managed-gateway-runtime/runtime-sync";
import { createDataEventHandler } from "./managed-gateway-runtime/data-events";
import { createDataIngestController } from "./managed-gateway-runtime/data-ingest";
import { createDataIngestSpool } from "./managed-gateway-runtime/data-ingest-spool";
import { createAnalyticsService } from "./managed-gateway-runtime/analytics-service";
import { createE2eRuntimeStore } from "./managed-gateway-runtime/e2e-runtime-store";

const APPROVED_NODES_KEY = "gym-motion.desktop.approved-nodes";
const RECEIVED_AT_ROLLUP_REBUILD_KEY = "gym-motion.desktop.rollups.received-at-v1";

export function createManagedGatewayRuntime(
  store: PreferencesStore,
): ManagedGatewayRuntime {
  const isE2E = process.env.GYM_MOTION_E2E === "1";
  const e2eRuntimeStore = isE2E ? createE2eRuntimeStore() : null;
  const listeners = new Set<(event: DesktopRuntimeEvent) => void>();
  const apiServer = createDesktopApiServer();
  let child: ChildProcess | null = null;
  let runtimePort = 4010;
  let snapshot = createEmptySnapshot();
  let setupState = createEmptySetupState();
  let startingPromise: Promise<void> | null = null;
  let stopped = false;
  let windowsAdapterRetryTimer: NodeJS.Timeout | null = null;
  let discoveredAdapters: BleAdapterSummary[] = [];
  let autoSelectedAdapterId: string | null = null;
  let windowsScanRequested = false;
  const intentionalChildExits = new WeakSet<ChildProcess>();
  const loadPersistedDevices = e2eRuntimeStore?.listDevices ?? listDevices;

  function ensureReceivedAtRollupsInBackground() {
    if (isE2E || store.getString(RECEIVED_AT_ROLLUP_REBUILD_KEY) === "done") {
      return;
    }

    void (async () => {
      try {
        if (!(await hasMotionRollupTables())) {
          return;
        }

        const client = await getDb().connect();
        try {
          console.warn("[runtime] rebuilding motion rollups with received-at timeline semantics");
          await rebuildMotionRollups(client);
          store.setString(RECEIVED_AT_ROLLUP_REBUILD_KEY, "done");
        } finally {
          client.release();
        }
      } catch (error) {
        console.error("[runtime] failed to rebuild motion rollups for received-at semantics", error);
      }
    })();
  }

  async function sendGatewayCommand(command: Record<string, unknown>) {
    await runtimeBridge.sendGatewayCommand(command);
  }

  function sendGatewayCommandInBackground(
    command: Record<string, unknown>,
    context: string,
  ) {
    runtimeBridge.sendGatewayCommandInBackground(command, context);
  }

  function emit(event: DesktopRuntimeEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function syncDeviceMetadataInBackground() {
    if (!child) {
      return;
    }

    void loadPersistedDevices()
      .then((devices) =>
        sendGatewayCommandInBackground(
          {
            type: "set_devices_metadata",
            devices,
          },
          "sync device metadata with gateway runtime",
        ),
      )
      .catch((error) => {
        console.error("[runtime] failed to load persisted device metadata", error);
      });
  }

  const analyticsService = createAnalyticsService({
    store,
    getRuntimeDevice: (deviceId) =>
      snapshot.devices.find((device) => device.id === deviceId) ?? null,
    onUpdated: (analytics) => {
      emit({
        type: "analytics-updated",
        analytics,
      });
    },
    listDeviceMotionEventsByReceivedAt: e2eRuntimeStore?.listDeviceMotionEventsByReceivedAt,
    findLatestDeviceMotionEventBeforeReceivedAt:
      e2eRuntimeStore?.findLatestDeviceMotionEventBeforeReceivedAt,
    getDeviceSyncState: e2eRuntimeStore?.getDeviceSyncState,
  });
  ensureReceivedAtRollupsInBackground();

  function emitSetup() {
    emit({
      type: "setup-updated",
      setup: setupState,
    });
  }

  function updateGatewayStatus(
    gateway: GatewayStatusSummary,
    runtimeState: DesktopSnapshot["runtimeState"],
    gatewayIssue: string | null,
  ) {
    snapshot = {
      ...snapshot,
      gateway,
      runtimeState,
      gatewayIssue,
      liveStatus: liveStatusFor({
        ...snapshot,
        gateway,
        runtimeState,
        gatewayIssue,
      }),
    };

    emit({
      type: "gateway-updated",
      gateway,
      liveStatus: snapshot.liveStatus,
      runtimeState,
      gatewayIssue,
    });
  }

  function setGatewayIssue(issue: string | null) {
    snapshot = {
      ...snapshot,
      gatewayIssue: issue,
      liveStatus: liveStatusFor({
        ...snapshot,
        gatewayIssue: issue,
      }),
    };
  }

  function emitGatewayIssueSnapshot() {
    emit({
      type: "gateway-updated",
      gateway: snapshot.gateway,
      liveStatus: snapshot.liveStatus,
      runtimeState: snapshot.runtimeState,
      gatewayIssue: snapshot.gatewayIssue,
    });
  }

  function reportHistoryRefreshFailure(detail: string) {
    setGatewayIssue(`History refresh unavailable: ${detail}`);
    emitGatewayIssueSnapshot();
  }

  function clearHistoryRefreshFailure() {
    if (!snapshot.gatewayIssue?.startsWith("History refresh unavailable:")) {
      return;
    }

    setGatewayIssue(null);
    emitGatewayIssueSnapshot();
  }

  function readApprovedNodes() {
    return normalizeApprovedNodes(store, APPROVED_NODES_KEY);
  }

  function reconcileApprovedNodesWithSnapshot() {
    const currentApprovedNodes = readApprovedNodes();
    const nextApprovedNodes = dedupeApprovedNodes(
      currentApprovedNodes.map((node) =>
        reconcileApprovedNodeRule(node, snapshot.devices, currentApprovedNodes),
      ),
    );

    if (JSON.stringify(nextApprovedNodes) === JSON.stringify(currentApprovedNodes)) {
      return currentApprovedNodes;
    }

    store.setJson(APPROVED_NODES_KEY, nextApprovedNodes);

    if (child) {
      sendGatewayCommandInBackground({
        type: "set_allowed_nodes",
        nodes: nextApprovedNodes,
      }, "sync approved nodes with gateway runtime");
    }

    return nextApprovedNodes;
  }

  function selectedAdapter() {
    return discoveredAdapters.find((adapter) => adapter.id === autoSelectedAdapterId) ?? null;
  }

  function persistApprovedNodes(nextNodes: ApprovedNodeRule[]) {
    const dedupedNodes = dedupeApprovedNodes(nextNodes);
    store.setJson(APPROVED_NODES_KEY, dedupedNodes);
    setupState = {
      ...setupState,
      approvedNodes: dedupedNodes,
    };
    emitSetup();
    if (pruneSnapshotToApprovedNodes(dedupedNodes)) {
      emit({ type: "snapshot", snapshot });
    }
    return dedupedNodes;
  }

  function runtimeDeviceById(nodeId: string) {
    return snapshot.devices.find((device) => device.id === nodeId) ?? null;
  }

  function resolveApprovedRuleIdForNode(nodeId: string) {
    if (setupState.approvedNodes.some((node) => node.id === nodeId)) {
      return nodeId;
    }

    const runtimeDevice = runtimeDeviceById(nodeId);
    if (!runtimeDevice) {
      return null;
    }

    const identity = createNodeIdentity({
      knownDeviceId: runtimeDevice.id,
      peripheralId: runtimeDevice.peripheralId,
      address: runtimeDevice.address ?? null,
      advertisedName: runtimeDevice.advertisedName,
    });
    const matchingRule = setupState.approvedNodes.find((rule) =>
      matchesApprovedNodeRule(rule, identity, setupState.approvedNodes),
    );

    return matchingRule?.id ?? null;
  }

  function applyManualScanPayload(payload: ManualScanPayload) {
    const approvedNodes = reconcileApprovedNodesWithSnapshot();

    setupState = {
      ...setupState,
      approvedNodes,
      manualScanState: payload.state ?? "idle",
      pairingCandidateId: payload.pairingCandidateId ?? null,
      manualScanError: payload.error ?? null,
      manualCandidates: Array.isArray(payload.candidates) ? payload.candidates : [],
    };
    emitSetup();
  }

  function applyAdapterSnapshot(
    adapters: BleAdapterSummary[],
    runtimeError: string | null = null,
  ) {
    const selectedAdapterId = applyAutoAdapterSelection(adapters, true);
    const adapterIssue = deriveAdapterIssue({
      adapters,
      selectedAdapterId,
      usesWindowsNativeGateway: true,
      runtimeError: runtimeError ?? undefined,
    });

    discoveredAdapters = adapters;
    autoSelectedAdapterId = selectedAdapterId;

    setupState = {
      ...setupState,
      adapterIssue,
      approvedNodes: readApprovedNodes(),
    };

    emitSetup();

    if (
      child &&
      adapters.length === 0 &&
      windowsAdapterRetryTimer === null
    ) {
      windowsAdapterRetryTimer = setTimeout(() => {
        windowsAdapterRetryTimer = null;
        applyAdapterSnapshot(discoveredAdapters, runtimeError);
      }, 1500);
      windowsAdapterRetryTimer.unref?.();
    }
  }

  function applyRuntimeDevicePatch(
    runtimeDevice: GatewayChildRuntimeMessage extends never
      ? never
      : Extract<GatewayChildRuntimeMessage, { type: "runtime-device-updated" }>["device"],
  ) {
    const nextDevice = mergeRuntimeDeviceIntoGatewaySnapshot(snapshot.devices, runtimeDevice);
    const nextSnapshot = pruneForgottenDevicesFromSnapshot(
      {
        ...snapshot,
        devices: mergeGatewayDeviceUpdate(snapshot.devices, nextDevice),
      },
      readApprovedNodes(),
    );
    snapshot = nextSnapshot;
    emit({ type: "device-upserted", device: nextDevice });
  }

  function handleChildRuntimeMessage(message: GatewayChildRuntimeMessage) {
    switch (message.type) {
      case "runtime-ready":
        applyAdapterSnapshot(message.adapters, message.issue);
        applyManualScanPayload(message.manualScan);
        updateGatewayStatus(
          message.gateway,
          message.issue ? "degraded" : "running",
          message.issue,
        );
        break;
      case "gateway-state":
        updateGatewayStatus(
          message.gateway,
          message.issue ? "degraded" : "running",
          message.issue,
        );
        break;
      case "adapters-updated":
        applyAdapterSnapshot(message.adapters, message.issue);
        break;
      case "manual-scan-updated":
        applyManualScanPayload(message.payload);
        break;
      case "runtime-device-updated":
        applyRuntimeDevicePatch(message.device);
        break;
      case "control-response":
        break;
    }
  }

  function pruneSnapshotToApprovedNodes(approvedNodes = readApprovedNodes()) {
    const nextSnapshot = pruneForgottenDevicesFromSnapshot(snapshot, approvedNodes);

    if (nextSnapshot === snapshot) {
      return false;
    }

    snapshot = nextSnapshot;
    return true;
  }

  function stopChild() {
    runtimeBridge.stopChild();
  }

  function runtimeStartIssue() {
    return runtimeBridge.runtimeStartIssue();
  }

  async function startChild() {
    await runtimeBridge.startChild();
  }

  const runtimeSync = createRuntimeSync({
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot;
    },
    getDevice: e2eRuntimeStore?.getDevice,
    listDevices: e2eRuntimeStore?.listDevices,
    listRecentEvents: e2eRuntimeStore?.listRecentEvents,
    listDeviceRecentEvents: e2eRuntimeStore?.listDeviceRecentEvents,
    listDeviceLogs: e2eRuntimeStore?.listDeviceLogs,
    listDeviceActivity: e2eRuntimeStore?.listDeviceActivity,
    listRecentActivity: e2eRuntimeStore?.listRecentActivity,
  });

  const applyDataEventToSnapshot = createDataEventHandler({
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot;
    },
    pruneSnapshot: (nextSnapshot) =>
      pruneForgottenDevicesFromSnapshot(nextSnapshot, readApprovedNodes()),
    emit,
    refreshHistory: () => runtimeSync.refreshHistory(),
    refreshDeviceHistory: (deviceId) => runtimeSync.refreshDeviceHistory(deviceId),
    refreshAnalyticsNow: (deviceId) => analyticsService.scheduleRefresh(deviceId, 0),
    scheduleAnalyticsRefresh: (deviceId) => analyticsService.scheduleRefresh(deviceId),
    recordLiveMotion: (event) => {
      if (event) {
        analyticsService.recordLiveMotion(event);
      }
    },
    reportHistoryRefreshFailure,
    clearHistoryRefreshFailure,
  });

  function applyDataEvent(event: Parameters<typeof applyDataEventToSnapshot>[0]) {
    applyDataEventToSnapshot(event);

    if (event.type !== "device-log") {
      syncDeviceMetadataInBackground();
    }
  }

  const dataIngest = createDataIngestController({
    applyDataEvent,
    recordMotion: e2eRuntimeStore?.recordMotion,
    recordHeartbeat: e2eRuntimeStore?.recordHeartbeat,
    recordLog: e2eRuntimeStore?.recordLog,
    recordBackfill: e2eRuntimeStore?.recordBackfill,
  });
  const dataIngestSpool = createDataIngestSpool({
    dbPath: path.join(app.getPath("userData"), "gateway-ingest-spool.sqlite"),
    persistValidatedMessage: (message) => dataIngest.persistValidatedMessage(message),
    onDrainError: (message, error) => {
      console.error(message, error);
    },
  });

  async function refreshHistory() {
    await runtimeSync.refreshHistory();
    syncDeviceMetadataInBackground();
  }

  async function startRuntime(options?: { preserveSnapshot?: boolean }) {
    await runtimeLifecycle.startRuntime(options);
  }

  apiServer.onEvent((event) => {
    applyDataEvent(event);
  });

  async function restartRuntime() {
    return runtimeLifecycle.restartRuntime();
  }

  function manualCandidateById(candidateId: string) {
    return setupState.manualCandidates.find((candidate) => candidate.id === candidateId) ?? null;
  }

  const runtimeBridge = createRuntimeBridge({
    getChild: () => child,
    setChild: (nextChild) => {
      child = nextChild;
    },
    getRuntimePort: () => runtimePort,
    setRuntimePort: (nextPort) => {
      runtimePort = nextPort;
    },
    selectedAdapter,
    readApprovedNodes,
    getWindowsScanRequested: () => windowsScanRequested,
    getDesktopApiBaseUrl: () => apiServer.apiBaseUrl,
    getStopped: () => stopped,
    intentionalChildExits,
    clearWindowsAdapterRetryTimer: () => {
      if (windowsAdapterRetryTimer) {
        clearTimeout(windowsAdapterRetryTimer);
        windowsAdapterRetryTimer = null;
      }
    },
    updateGatewayStatus,
    onChildPersistMessage: (message) => dataIngestSpool.enqueue(message),
    onChildRuntimeMessage: handleChildRuntimeMessage,
  });

  const runtimeLifecycle = createRuntimeLifecycle({
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot;
    },
    setStopped: (nextStopped) => {
      stopped = nextStopped;
    },
    stopChild,
    apiServerStart: () => apiServer.start(),
    runtimeStartIssue,
    startChild,
    refreshHistory,
    setGatewayIssue,
    onHistoryRefreshError: (error) => {
      const detail =
        error instanceof Error
          ? error.message
          : "History refresh failed while starting the gateway runtime.";
      setGatewayIssue(`History refresh unavailable: ${detail}`);
      console.error("[runtime] history refresh failed during startup", error);
    },
    applyManualScanPayload,
    emitSnapshot: () => {
      emit({ type: "snapshot", snapshot });
    },
    setWindowsScanRequested: (requested) => {
      windowsScanRequested = requested;
    },
  });

  const runtimeIntents = createOperatorIntents({
    getSetupState: () => setupState,
    setSetupState: (nextSetupState) => {
      setupState = nextSetupState;
    },
    emitSetup,
    getChild: () => child,
    refreshAdapters: async () => {
      applyAdapterSnapshot(discoveredAdapters);
    },
    sendGatewayCommand,
    restartRuntime,
    manualCandidateById,
    persistApprovedNodes,
    runtimeDeviceById,
    resolveApprovedRuleIdForNode,
    applyManualScanPayload,
    setWindowsScanRequested: (requested) => {
      windowsScanRequested = requested;
    },
  });

  async function startManualScan() {
    await runtimeIntents.startManualScan();
  }

  async function pairDiscoveredNode(candidateId: string) {
    return runtimeIntents.pairDiscoveredNode(candidateId);
  }

  async function resumeApprovedNodeReconnect(ruleId: string) {
    await runtimeIntents.resumeApprovedNodeReconnect(ruleId);
  }

  return {
    async start() {
      if (startingPromise) {
        return startingPromise;
      }

      stopped = false;
      startingPromise = dataIngestSpool.start().then(() => startRuntime()).finally(() => {
        startingPromise = null;
      });
      return startingPromise;
    },
    async stop() {
      stopped = true;

      stopChild();
      emitSetup();
      await apiServer.stop();
      await dataIngestSpool.stop();
    },
    restart: restartRuntime,
    async getSnapshot() {
      return snapshot;
    },
    async getSetupState() {
      applyAdapterSnapshot(discoveredAdapters);
      return setupState;
    },
    startManualScan,
    pairDiscoveredNode,
    async pairManualCandidate(candidateId) {
      return runtimeIntents.pairManualCandidate(candidateId);
    },
    async forgetNode(nodeId) {
      return runtimeIntents.forgetNode(nodeId);
    },
    async recoverApprovedNode(ruleId) {
      await runtimeIntents.recoverApprovedNode(ruleId);
    },
    async resumeReconnectForNode(nodeId) {
      await runtimeIntents.resumeReconnectForNode(nodeId);
    },
    resumeApprovedNodeReconnect,
    async setAllowedNodes(nodes) {
      return runtimeIntents.setAllowedNodes(nodes);
    },
    async getDeviceAnalytics(input) {
      return analyticsService.getDeviceAnalytics(input);
    },
    async getDeviceActivity(deviceId, limit) {
      return runtimeSync.getDeviceActivity(deviceId, limit);
    },
    async runE2eStep(name, payload) {
      if (!isE2E) {
        throw new Error("Desktop E2E test driver is disabled.");
      }

      return sendGatewayCommand({
        type: "e2e_step",
        name,
        payload,
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
