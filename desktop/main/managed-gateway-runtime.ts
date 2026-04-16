import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { ApprovedNodeRule, BleAdapterSummary } from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";
import { app } from "electron";
import { hasMotionRollupTables, listDevices, rebuildMotionRollups } from "../../backend/data";
import { getDb } from "../../backend/data/db";

import { createDesktopApiServer } from "./desktop-api-server";
import type { PreferencesStore } from "./preferences-store";
import {
  matchesApprovedNodeRule,
  reconcileApprovedNodeRule,
  createNodeIdentity,
} from "./setup-selection";
import {
  createManagedRuntimeStateController,
} from "./managed-gateway-runtime/state-controller";
import { createEmptySnapshot } from "./managed-gateway-runtime/snapshot";
import {
  dedupeApprovedNodes,
  normalizeApprovedNodes,
} from "./managed-gateway-runtime/setup-state";
import {
  type ManagedGatewayRuntime,
  type ManualScanPayload,
} from "./managed-gateway-runtime/common";
import type {
  GatewayChildRuntimeMessage,
  GatewayControlCommand,
  GatewayControlCommandResult,
} from "./managed-gateway-runtime/gateway-child-ipc";
import { createRuntimeBridge } from "./managed-gateway-runtime/runtime-bridge";
import { createRuntimeLifecycle } from "./managed-gateway-runtime/lifecycle";
import { createOperatorIntents } from "./managed-gateway-runtime/operator-intents";
import { createRuntimeSync } from "./managed-gateway-runtime/runtime-sync";
import { createDataEventHandler } from "./managed-gateway-runtime/data-events";
import {
  createDataIngestController,
  validateGatewayChildPersistMessage,
  type ValidatedGatewayChildPersistMessage,
} from "./managed-gateway-runtime/data-ingest";
import { createDataIngestSpool } from "./managed-gateway-runtime/data-ingest-spool";
import { createAnalyticsService } from "./managed-gateway-runtime/analytics-service";
import { createE2eRuntimeStore } from "./managed-gateway-runtime/e2e-runtime-store";
import { createRuntimeCache } from "./managed-gateway-runtime/runtime-cache";

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
  const runtimeCache = createRuntimeCache(createEmptySnapshot());
  let startingPromise: Promise<void> | null = null;
  let stopped = false;
  let windowsAdapterRetryTimer: NodeJS.Timeout | null = null;
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

  async function sendGatewayCommand<TCommand extends GatewayControlCommand>(
    command: TCommand,
  ): Promise<GatewayControlCommandResult<TCommand>> {
    return await runtimeBridge.sendGatewayCommand(command);
  }

  function sendGatewayCommandInBackground(
    command: GatewayControlCommand,
    context: string,
  ) {
    runtimeBridge.sendGatewayCommandInBackground(command, context);
  }

  function emit(event: DesktopRuntimeEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  const stateController = createManagedRuntimeStateController({
    emit,
    readApprovedNodes,
    runtimeCache,
  });
  const {
    getSnapshot: getCurrentSnapshot,
    setSnapshot: replaceSnapshot,
    emitSnapshot,
    emitRuntimeBatch,
    getSetupState: getCurrentSetupState,
    setSetupState: replaceSetupState,
    emitSetup,
    updateGatewayStatus,
    setGatewayIssue,
    emitGatewayIssueSnapshot,
    getDiscoveredAdapters,
    applyAdapterSnapshot,
    applyManualScanPayload,
    pruneSnapshotToApprovedNodes,
    pruneSnapshot,
    applyRuntimeDevicePatch,
    getWindowsScanRequested,
    setWindowsScanRequested,
  } = stateController;

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
    getRuntimeDevice: (deviceId) => runtimeCache.getDevice(deviceId),
    onUpdated: (analytics) => {
      emit({
        type: "analytics-updated",
        analytics,
      });
    },
    listDeviceMotionEventsByReceivedAt: e2eRuntimeStore?.listDeviceMotionEventsByReceivedAt,
    findLatestDeviceMotionEventBeforeReceivedAt:
      e2eRuntimeStore?.findLatestDeviceMotionEventBeforeReceivedAt,
  });
  ensureReceivedAtRollupsInBackground();

  function reportSnapshotRefreshFailure(detail: string) {
    setGatewayIssue(`Snapshot refresh unavailable: ${detail}`);
    emitGatewayIssueSnapshot();
  }

  function readApprovedNodes() {
    return normalizeApprovedNodes(store, APPROVED_NODES_KEY);
  }

  function reconcileApprovedNodesWithSnapshot() {
    const currentApprovedNodes = readApprovedNodes();
    const nextApprovedNodes = dedupeApprovedNodes(
      currentApprovedNodes.map((node) =>
        reconcileApprovedNodeRule(node, getCurrentSnapshot().devices, currentApprovedNodes),
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

  function persistApprovedNodes(nextNodes: ApprovedNodeRule[]) {
    const dedupedNodes = dedupeApprovedNodes(nextNodes);
    store.setJson(APPROVED_NODES_KEY, dedupedNodes);
    replaceSetupState({
      ...getCurrentSetupState(),
      approvedNodes: dedupedNodes,
    });
    emitSetup();
    if (pruneSnapshotToApprovedNodes(dedupedNodes)) {
      emitSnapshot();
    }
    return dedupedNodes;
  }

  function runtimeDeviceById(nodeId: string) {
    return getCurrentSnapshot().devices.find((device) => device.id === nodeId) ?? null;
  }

  function resolveApprovedRuleIdForNode(nodeId: string) {
    if (getCurrentSetupState().approvedNodes.some((node) => node.id === nodeId)) {
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
    const matchingRule = getCurrentSetupState().approvedNodes.find((rule) =>
      matchesApprovedNodeRule(rule, identity, getCurrentSetupState().approvedNodes),
    );

    return matchingRule?.id ?? null;
  }

  function applyAdapterSnapshotWithRetry(
    adapters: BleAdapterSummary[],
    runtimeError: string | null = null,
  ) {
    applyAdapterSnapshot(adapters, runtimeError);

    if (
      child &&
      adapters.length === 0 &&
      windowsAdapterRetryTimer === null
    ) {
      windowsAdapterRetryTimer = setTimeout(() => {
        windowsAdapterRetryTimer = null;
        applyAdapterSnapshotWithRetry(getDiscoveredAdapters(), runtimeError);
      }, 1500);
      windowsAdapterRetryTimer.unref?.();
    }
  }

  function applyManualScanPayloadWithReconciledNodes(payload: ManualScanPayload) {
    applyManualScanPayload(payload, reconcileApprovedNodesWithSnapshot());
  }

  function handleChildRuntimeMessage(message: GatewayChildRuntimeMessage) {
    switch (message.type) {
      case "runtime-ready":
        applyAdapterSnapshotWithRetry(message.adapters, message.issue);
        applyManualScanPayloadWithReconciledNodes(message.manualScan);
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
        applyAdapterSnapshotWithRetry(message.adapters, message.issue);
        break;
      case "manual-scan-updated":
        applyManualScanPayloadWithReconciledNodes(message.payload);
        break;
      case "runtime-device-updated":
        applyRuntimeDevicePatch(message.device);
        break;
      case "control-response":
        break;
    }
  }

  function applyOptimisticPersistMessage(message: ValidatedGatewayChildPersistMessage) {
    switch (message.type) {
      case "persist-motion": {
        const patch = runtimeCache.recordOptimisticMotion(message.messageId, message.payload);
        getCurrentSnapshot();
        emitRuntimeBatch(patch);
        break;
      }
      case "persist-device-log": {
        const patch = runtimeCache.recordOptimisticLog(message.messageId, message.payload);
        getCurrentSnapshot();
        emitRuntimeBatch(patch);
        break;
      }
      default:
        break;
    }
  }

  async function stopChild() {
    await runtimeBridge.stopChild();
  }

  function runtimeStartIssue() {
    return runtimeBridge.runtimeStartIssue();
  }

  async function startChild() {
    await runtimeBridge.startChild();
  }

  const runtimeSync = createRuntimeSync({
    getSnapshot: getCurrentSnapshot,
    setSnapshot: replaceSnapshot,
    getDevice: e2eRuntimeStore?.getDevice,
    listDevices: e2eRuntimeStore?.listDevices,
    listRecentEvents: e2eRuntimeStore?.listRecentEvents,
    listDeviceRecentEvents: e2eRuntimeStore?.listDeviceRecentEvents,
    listDeviceLogs: e2eRuntimeStore?.listDeviceLogs,
    listDeviceActivity: e2eRuntimeStore?.listDeviceActivity,
    listRecentActivity: e2eRuntimeStore?.listRecentActivity,
  });

  const applyDataEventToSnapshot = createDataEventHandler({
    getSnapshot: getCurrentSnapshot,
    setSnapshot: replaceSnapshot,
    pruneSnapshot,
    clearOptimisticMessage: (messageId) => runtimeCache.clearOptimisticMessage(messageId),
    emit,
    refreshAnalyticsNow: (deviceId) => analyticsService.scheduleRefresh(deviceId, 0),
    scheduleAnalyticsRefresh: (deviceId) => analyticsService.scheduleRefresh(deviceId),
    recordLiveMotion: (event) => {
      if (event) {
        analyticsService.recordLiveMotion(event);
      }
    },
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
  });
  const dataIngestSpool = createDataIngestSpool({
    dbPath: path.join(app.getPath("userData"), "gateway-ingest-spool.sqlite"),
    persistValidatedMessage: (message) => dataIngest.persistValidatedMessage(message),
    onDrainError: (message, error) => {
      console.error(message, error);
    },
  });

  async function refreshSnapshotData() {
    await runtimeSync.refreshSnapshotData();
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
    return getCurrentSetupState().manualCandidates.find((candidate) => candidate.id === candidateId) ?? null;
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
    readApprovedNodes,
    getWindowsScanRequested,
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
    onChildPersistMessage: (message) => {
      const validated = validateGatewayChildPersistMessage(message);
      applyOptimisticPersistMessage(validated);
      return dataIngestSpool.enqueueValidated(validated);
    },
    onChildRuntimeMessage: handleChildRuntimeMessage,
  });

  const runtimeLifecycle = createRuntimeLifecycle({
    getSnapshot: getCurrentSnapshot,
    setSnapshot: replaceSnapshot,
    setStopped: (nextStopped) => {
      stopped = nextStopped;
    },
    stopChild,
    apiServerStart: () => apiServer.start(),
    runtimeStartIssue,
    startChild,
    refreshSnapshotData,
    setGatewayIssue,
    onSnapshotRefreshError: (error) => {
      const detail =
        error instanceof Error
          ? error.message
          : "Snapshot refresh failed while starting the gateway runtime.";
      reportSnapshotRefreshFailure(detail);
      console.error("[runtime] snapshot refresh failed during startup", error);
    },
    applyManualScanPayload: applyManualScanPayloadWithReconciledNodes,
    emitSnapshot,
    setWindowsScanRequested,
  });

  const runtimeIntents = createOperatorIntents({
    getSetupState: getCurrentSetupState,
    setSetupState: replaceSetupState,
    emitSetup,
    getChild: () => child,
    refreshAdapters: async () => {
      applyAdapterSnapshotWithRetry(getDiscoveredAdapters());
    },
    sendGatewayCommand,
    restartRuntime,
    manualCandidateById,
    persistApprovedNodes,
    runtimeDeviceById,
    resolveApprovedRuleIdForNode,
    applyManualScanPayload: applyManualScanPayloadWithReconciledNodes,
    setWindowsScanRequested,
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

      await stopChild();
      emitSetup();
      await apiServer.stop();
      await dataIngestSpool.stop();
    },
    restart: restartRuntime,
    async getSnapshot() {
      return getCurrentSnapshot();
    },
    async getSetupState() {
      applyAdapterSnapshotWithRetry(getDiscoveredAdapters());
      return getCurrentSetupState();
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
