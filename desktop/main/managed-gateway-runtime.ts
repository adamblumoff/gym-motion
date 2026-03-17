import type { ChildProcess } from "node:child_process";
import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  DesktopSnapshot,
  GatewayStatusSummary,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

import { createDesktopApiServer } from "./desktop-api-server";
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
  fetchJson,
  type ManagedGatewayRuntime,
  type ManualScanPayload,
} from "./managed-gateway-runtime/common";
import { createRuntimeBridge } from "./managed-gateway-runtime/runtime-bridge";
import { createRuntimeLifecycle } from "./managed-gateway-runtime/lifecycle";
import { createOperatorIntents } from "./managed-gateway-runtime/operator-intents";
import { createRuntimeSync } from "./managed-gateway-runtime/runtime-sync";
import { createDataEventHandler } from "./managed-gateway-runtime/data-events";
import { createDataIngestController } from "./managed-gateway-runtime/data-ingest";
import { createAnalyticsController } from "./managed-gateway-runtime/analytics-controller";

const APPROVED_NODES_KEY = "gym-motion.desktop.approved-nodes";

export function createManagedGatewayRuntime(
  store: PreferencesStore,
): ManagedGatewayRuntime {
  const listeners = new Set<(event: DesktopRuntimeEvent) => void>();
  const apiServer = createDesktopApiServer();
  let child: ChildProcess | null = null;
  let runtimePort = 4010;
  let pollTimer: NodeJS.Timeout | null = null;
  let snapshot = createEmptySnapshot();
  let setupState = createEmptySetupState();
  let startingPromise: Promise<void> | null = null;
  let stopped = false;
  let windowsAdapterRetryTimer: NodeJS.Timeout | null = null;
  let discoveredAdapters: BleAdapterSummary[] = [];
  let autoSelectedAdapterId: string | null = null;
  let windowsScanRequested = false;
  const intentionalChildExits = new WeakSet<ChildProcess>();

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

  async function refreshAdapters() {
    const adapterPayload =
      child
        ? await fetchJson<{ adapters: BleAdapterSummary[]; error?: string }>(
            `http://127.0.0.1:${runtimePort}/adapters`,
          )
        : {
            adapters: discoveredAdapters,
            error: undefined,
          };
    const adapters = adapterPayload.adapters;
    const selectedAdapterId = applyAutoAdapterSelection(adapters, true);
    const adapterIssue = deriveAdapterIssue({
      adapters,
      selectedAdapterId,
      usesWindowsNativeGateway: true,
      runtimeError: adapterPayload.error,
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
        void refreshAdapters().catch((error) => {
          console.error("[runtime] failed to retry Windows adapter refresh", error);
        });
      }, 1500);
      windowsAdapterRetryTimer.unref?.();
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

  const analyticsController = createAnalyticsController(store);

  const runtimeSync = createRuntimeSync({
    getChild: () => child,
    getRuntimePort: () => runtimePort,
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot;
    },
    getSetupState: () => setupState,
    updateGatewayStatus,
    refreshAdapters,
    applyManualScanPayload,
    pruneSnapshot: (nextSnapshot) =>
      pruneForgottenDevicesFromSnapshot(nextSnapshot, readApprovedNodes()),
    emit,
  });

  const applyDataEvent = createDataEventHandler({
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot;
    },
    pruneSnapshot: (nextSnapshot) =>
      pruneForgottenDevicesFromSnapshot(nextSnapshot, readApprovedNodes()),
    emit,
    refreshManualScanState: () => runtimeSync.refreshManualScanState(),
    refreshGatewayState: () => runtimeSync.refreshGatewayState(),
    refreshHistory: () => runtimeSync.refreshHistory(),
  });

  const dataIngest = createDataIngestController({
    applyDataEvent,
  });

  async function refreshManualScanState() {
    await runtimeSync.refreshManualScanState();
  }

  async function refreshHistory() {
    await runtimeSync.refreshHistory();
  }

  async function refreshGatewayState() {
    await runtimeSync.refreshGatewayState();
  }

  async function startRuntime(options?: { preserveSnapshot?: boolean }) {
    await runtimeLifecycle.startRuntime(options);
  }

  apiServer.onEvent((event) => {
    if (event.type === "motion-update") {
      analyticsController.invalidateDeviceAnalytics(event.payload.device.id);
    }

    if (event.type === "backfill-recorded") {
      analyticsController.invalidateDeviceAnalytics(event.deviceId);
    }

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
    getStopped: () => stopped,
    intentionalChildExits,
    clearWindowsAdapterRetryTimer: () => {
      if (windowsAdapterRetryTimer) {
        clearTimeout(windowsAdapterRetryTimer);
        windowsAdapterRetryTimer = null;
      }
    },
    updateGatewayStatus,
    getApiBaseUrl: () => apiServer.apiBaseUrl,
    onChildPersistMessage: (message) => dataIngest.handleMessage(message),
  });

  const runtimeLifecycle = createRuntimeLifecycle({
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot;
    },
    getPollTimer: () => pollTimer,
    setPollTimer: (nextTimer) => {
      pollTimer = nextTimer;
    },
    setStopped: (nextStopped) => {
      stopped = nextStopped;
    },
    stopChild,
    apiServerStart: () => apiServer.start(),
    runtimeStartIssue,
    startChild,
    refreshAdapters,
    refreshGatewayState,
    refreshHistory,
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
    refreshAdapters,
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
    return runtimeIntents.startManualScan();
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
      startingPromise = startRuntime().finally(() => {
        startingPromise = null;
      });
      return startingPromise;
    },
    async stop() {
      stopped = true;

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      stopChild();
      emitSetup();
      await apiServer.stop();
    },
    restart: restartRuntime,
    async getSnapshot() {
      return snapshot;
    },
    async getSetupState() {
      await refreshAdapters();
      if (child) {
        await refreshManualScanState();
      }
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
    getDeviceAnalytics(deviceId, range) {
      return analyticsController.getDeviceAnalytics(deviceId, range);
    },
    refreshDeviceAnalytics(deviceId, range) {
      return analyticsController.refreshDeviceAnalytics(deviceId, range);
    },
    deleteDeviceAnalyticsHistory(deviceId) {
      return analyticsController.deleteDeviceAnalyticsHistory(deviceId);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
