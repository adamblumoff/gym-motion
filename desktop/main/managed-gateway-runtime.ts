import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { app } from "electron";
import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  MotionStreamPayload,
} from "@core/contracts";
import {
  mergeActivityUpdate,
  mergeEventUpdate,
  mergeGatewayDeviceUpdate,
  mergeLogUpdate,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

import { listBleAdapters } from "./ble-adapters";
import { createDesktopApiServer, type DesktopDataEvent } from "./desktop-api-server";
import { mergeRepositoryDeviceIntoGatewaySnapshot } from "./gateway-snapshot";
import {
  resolveGatewayScriptPath,
  resolveWindowsSidecarPath,
  usesWindowsNativeGateway,
} from "./gateway-runtime-target";
import type { PreferencesStore } from "./preferences-store";
import {
  reconcileApprovedNodeRule,
} from "./setup-selection";
import {
  applyAutoAdapterSelection,
  deriveAdapterIssue,
} from "./managed-gateway-runtime/adapters";
import {
  createEmptySetupState,
  createEmptySnapshot,
  degradedEmptySnapshot,
  EMPTY_GATEWAY,
  liveStatusFor,
  normalizeGatewayHealth,
} from "./managed-gateway-runtime/snapshot";
import { pruneForgottenDevicesFromSnapshot } from "./managed-gateway-runtime/approved-node-prune";
import {
  dedupeApprovedNodes,
  normalizeApprovedNodes,
} from "./managed-gateway-runtime/setup-state";
import {
  listDeviceActivity,
  listDeviceLogs,
  listRecentEvents,
} from "../../backend/data";

type ManagedGatewayRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<DesktopSnapshot>;
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSetupState: () => Promise<DesktopSetupState>;
  startManualScan: () => Promise<DesktopSetupState>;
  pairManualCandidate: (candidateId: string) => Promise<DesktopSetupState>;
  recoverApprovedNode: (ruleId: string) => Promise<void>;
  resumeApprovedNodeReconnect: (ruleId: string) => Promise<void>;
  setAllowedNodes: (nodes: ApprovedNodeRule[]) => Promise<DesktopSetupState>;
  onEvent: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
};

const APPROVED_NODES_KEY = "gym-motion.desktop.approved-nodes";

type ManualScanPayload = {
  state?: DesktopSetupState["manualScanState"];
  pairingCandidateId?: string | null;
  error?: string | null;
  candidates?: DesktopSetupState["manualCandidates"];
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-store",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }

  return (await response.json()) as T;
}

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
    if (!child || child.killed) {
      throw new Error("Gateway runtime is not running.");
    }

    if (usesWindowsNativeGateway(process.platform)) {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/control`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`gateway control -> ${response.status}: ${text}`);
      }

      return;
    }

    const currentChild = child;

    if (!currentChild.stdin) {
      throw new Error("Gateway runtime control pipe is unavailable.");
    }

    await new Promise<void>((resolve, reject) => {
      currentChild.stdin?.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  function sendGatewayCommandInBackground(
    command: Record<string, unknown>,
    context: string,
  ) {
    void sendGatewayCommand(command).catch((error) => {
      console.error(`[runtime] failed to ${context}`, error);
    });
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
    const usingWindowsGateway = usesWindowsNativeGateway(process.platform);
    const adapterPayload =
      usingWindowsGateway
        ? child
          ? await fetchJson<{ adapters: BleAdapterSummary[]; error?: string }>(
              `http://127.0.0.1:${runtimePort}/adapters`,
            )
          : {
              adapters: discoveredAdapters,
              error: undefined,
            }
        : {
            adapters: await listBleAdapters(),
            error: undefined,
          };
    const adapters = adapterPayload.adapters;
    const selectedAdapterId = applyAutoAdapterSelection(adapters, usingWindowsGateway);
    const adapterIssue = deriveAdapterIssue({
      adapters,
      selectedAdapterId,
      usesWindowsNativeGateway: usingWindowsGateway,
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
      usingWindowsGateway &&
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

  async function refreshManualScanState() {
    if (!child) {
      applyManualScanPayload({
        state: "idle",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      });
      return;
    }

    const manualScanPayload = await fetchJson<ManualScanPayload>(
      `http://127.0.0.1:${runtimePort}/manual-scan`,
    );

    applyManualScanPayload(manualScanPayload);
  }

  async function refreshHistory() {
    const [events, logs] = await Promise.all([
      listRecentEvents(14),
      listDeviceLogs({ limit: 18 }),
    ]);
    const activityGroups = await Promise.all(
      snapshot.devices.map((device) =>
        listDeviceActivity({ deviceId: device.id, limit: 12 }),
      ),
    );
    const activities = activityGroups
      .flat()
      .toSorted(
        (left, right) =>
          new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime(),
      )
      .slice(0, 30);

    snapshot = {
      ...snapshot,
      events,
      logs,
      activities,
    };
  }

  async function refreshGatewayState() {
    if (!child) {
      applyManualScanPayload({
        state: "idle",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      });
      return;
    }

    const baseUrl = `http://127.0.0.1:${runtimePort}`;

    try {
      const [healthPayload, devicesPayload] = await Promise.all([
        fetchJson<{ ok: boolean; gateway: GatewayStatusSummary; error?: string }>(
          `${baseUrl}/health`,
        ),
        fetchJson<{
          ok: boolean;
          gateway: GatewayStatusSummary;
          devices: GatewayRuntimeDeviceSummary[];
          error?: string;
        }>(`${baseUrl}/devices`),
      ]);

      const nextRuntimeState =
        healthPayload.ok && devicesPayload.ok ? "running" : "degraded";

      updateGatewayStatus(
        normalizeGatewayHealth(healthPayload),
        nextRuntimeState,
        healthPayload.error ?? devicesPayload.error ?? setupState.adapterIssue,
      );

      const previousIds = new Set(snapshot.devices.map((device) => device.id));
      snapshot = {
        ...snapshot,
        devices: devicesPayload.devices,
      };
      pruneSnapshotToApprovedNodes();

      if (usesWindowsNativeGateway(process.platform)) {
        await refreshAdapters();
      }

      await refreshManualScanState();

      if (
        previousIds.size !== devicesPayload.devices.length ||
        devicesPayload.devices.some((device) => !previousIds.has(device.id))
      ) {
        await refreshHistory();
        emit({ type: "snapshot", snapshot });
        return;
      }

      for (const device of devicesPayload.devices) {
        if (!snapshot.devices.some((currentDevice) => currentDevice.id === device.id)) {
          continue;
        }
        emit({ type: "device-upserted", device });
      }
    } catch (error) {
      updateGatewayStatus(
        {
          ...snapshot.gateway,
          updatedAt: new Date().toISOString(),
        },
        "degraded",
        error instanceof Error ? error.message : "Gateway runtime unavailable.",
      );
    }
  }

  function restartPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
    }

    pollTimer = setInterval(() => {
      void refreshGatewayState();
    }, 1000);
    pollTimer.unref?.();
  }

  function stopChild() {
    if (!child) {
      return;
    }

    if (windowsAdapterRetryTimer) {
      clearTimeout(windowsAdapterRetryTimer);
      windowsAdapterRetryTimer = null;
    }

    const exitingChild = child;
    intentionalChildExits.add(exitingChild);
    child = null;
    exitingChild.kill("SIGTERM");
  }

  function runtimeStartIssue() {
    if (usesWindowsNativeGateway(process.platform)) {
      return null;
    }

    if (setupState.adapterIssue) {
      return setupState.adapterIssue;
    }

    const adapter = selectedAdapter();

    if (!adapter) {
      return "No compatible BLE adapters were detected.";
    }

    if (!adapter.isAvailable || adapter.runtimeDeviceId === null) {
      return adapter.issue ?? "The detected BLE adapter cannot be used.";
    }

    return null;
  }

  async function startChild() {
    const adapter = selectedAdapter();

    if (
      !usesWindowsNativeGateway(process.platform) &&
      (!adapter || adapter.runtimeDeviceId === null)
    ) {
      throw new Error("No BLE adapter is selected.");
    }

    runtimePort = 4010 + Math.floor(Math.random() * 2000);
    const env: Record<string, string | undefined> = {
      ...process.env,
      API_URL: apiServer.apiBaseUrl,
      GATEWAY_RUNTIME_HOST: "127.0.0.1",
      GATEWAY_RUNTIME_PORT: String(runtimePort),
      GATEWAY_APPROVED_NODE_RULES: JSON.stringify(readApprovedNodes()),
    };

    if (usesWindowsNativeGateway(process.platform)) {
      env.GATEWAY_SELECTED_ADAPTER_ID = adapter?.id ?? "";
      env.GATEWAY_START_SCAN_ON_BOOT = windowsScanRequested ? "1" : "0";
      env.GATEWAY_SIDECAR_PATH = resolveWindowsSidecarPath({
        isPackaged: app.isPackaged,
        cwd: process.cwd(),
        resourcesPath: process.resourcesPath,
      });
    } else {
      env.NOBLE_HCI_DEVICE_ID = String(adapter?.runtimeDeviceId);
    }

    const spawnedChild = spawn(
      process.execPath,
      [
        resolveGatewayScriptPath({
          platform: process.platform,
          isPackaged: app.isPackaged,
          cwd: process.cwd(),
          resourcesPath: process.resourcesPath,
        }),
      ],
      {
        cwd: app.isPackaged ? process.resourcesPath : process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child = spawnedChild;

    spawnedChild.stdout?.on("data", (chunk) => {
      process.stdout.write(`[gateway] ${chunk}`);
    });
    spawnedChild.stderr?.on("data", (chunk) => {
      process.stderr.write(`[gateway] ${chunk}`);
    });
    spawnedChild.once("exit", (code, signal) => {
      const wasIntentional = intentionalChildExits.has(spawnedChild);

      if (child === spawnedChild) {
        child = null;
      }

      if (stopped || wasIntentional) {
        return;
      }

      updateGatewayStatus(
        { ...EMPTY_GATEWAY, updatedAt: new Date().toISOString() },
        "degraded",
        `Gateway exited (${signal ?? code ?? "unknown"}).`,
      );
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await fetchJson(`${`http://127.0.0.1:${runtimePort}`}/health`);
        return;
      } catch {
        await delay(500);
      }
    }

    throw new Error("Gateway runtime did not become healthy.");
  }

  function applyDataEvent(event: DesktopDataEvent) {
    switch (event.type) {
      case "motion-update": {
        const payload: MotionStreamPayload = event.payload;
        const device = mergeRepositoryDeviceIntoGatewaySnapshot(
          snapshot.devices,
          payload.device,
        );
        snapshot = {
          ...snapshot,
          devices: mergeGatewayDeviceUpdate(snapshot.devices, device),
        };
        pruneSnapshotToApprovedNodes();
        if (!snapshot.devices.some((currentDevice) => currentDevice.id === device.id)) {
          break;
        }
        emit({
          type: "device-upserted",
          device,
        });
        if (payload.event) {
          snapshot = {
            ...snapshot,
            events: mergeEventUpdate(snapshot.events, payload.event, 14),
          };
          emit({ type: "event-recorded", event: payload.event });
          const activity: DeviceActivitySummary = {
            id: `motion-${payload.event.id}`,
            deviceId: payload.event.deviceId,
            sequence: payload.event.sequence,
            kind: "motion",
            title: payload.event.state.toUpperCase(),
            message: `Gateway recorded ${payload.event.state} for ${payload.event.deviceId}.`,
            state: payload.event.state,
            level: null,
            code: "motion.state",
            delta: payload.event.delta,
            eventTimestamp: payload.event.eventTimestamp,
            receivedAt: payload.event.receivedAt,
            bootId: payload.event.bootId,
            firmwareVersion: payload.event.firmwareVersion,
            hardwareId: payload.event.hardwareId,
            metadata:
              payload.event.delta === null
                ? null
                : { delta: payload.event.delta },
          };
          snapshot = {
            ...snapshot,
            activities: mergeActivityUpdate(snapshot.activities, activity, 30),
          };
          emit({ type: "activity-recorded", activity });
        }
        void refreshManualScanState();
        break;
      }
      case "device-log": {
        const payload: DeviceLogSummary = event.payload;
        const activity: DeviceActivitySummary = {
          id: `log-${payload.id}`,
          deviceId: payload.deviceId,
          sequence: payload.sequence,
          kind: "lifecycle",
          title: payload.code ?? payload.level.toUpperCase(),
          message: payload.message,
          state: null,
          level: payload.level,
          code: payload.code,
          delta: null,
          eventTimestamp: payload.deviceTimestamp,
          receivedAt: payload.receivedAt,
          bootId: payload.bootId,
          firmwareVersion: payload.firmwareVersion,
          hardwareId: payload.hardwareId,
          metadata: payload.metadata,
        };
        snapshot = {
          ...snapshot,
          logs: mergeLogUpdate(snapshot.logs, payload, 18),
          activities: mergeActivityUpdate(snapshot.activities, activity, 30),
        };
        emit({ type: "log-recorded", log: payload });
        emit({ type: "activity-recorded", activity });
        break;
      }
      case "device-updated":
        void refreshGatewayState().then(() => {
          emit({ type: "snapshot", snapshot });
        });
        break;
      case "backfill-recorded":
        void refreshHistory().then(() => {
          emit({ type: "snapshot", snapshot });
        });
        break;
    }
  }

  async function startRuntime(options?: { preserveSnapshot?: boolean }) {
    const preserveSnapshot = options?.preserveSnapshot ?? false;

    if (!preserveSnapshot) {
      snapshot = createEmptySnapshot();
      emit({ type: "snapshot", snapshot });
      applyManualScanPayload({
        state: "idle",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      });
    } else {
      snapshot = {
        ...snapshot,
        runtimeState: "restarting",
        liveStatus: liveStatusFor({
          ...snapshot,
          runtimeState: "restarting",
        }),
        gatewayIssue: null,
      };
      emit({ type: "snapshot", snapshot });
    }

    if (!usesWindowsNativeGateway(process.platform)) {
      await refreshAdapters();
    }

    const startIssue = runtimeStartIssue();

    if (startIssue) {
      snapshot = degradedEmptySnapshot(startIssue);
      emit({ type: "snapshot", snapshot });
      return;
    }

    try {
      await apiServer.start();
      await startChild();
      await refreshAdapters();
      await refreshGatewayState();
      await refreshHistory();
      emit({ type: "snapshot", snapshot });
      restartPolling();
      windowsScanRequested = false;
    } catch (error) {
      windowsScanRequested = false;
      snapshot = degradedEmptySnapshot(
        error instanceof Error ? error.message : "Gateway runtime failed to start.",
      );
      emit({ type: "snapshot", snapshot });
      throw error;
    }
  }

  apiServer.onEvent((event) => {
    applyDataEvent(event);
  });

  async function restartRuntime() {
    stopped = false;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    stopChild();
    snapshot = {
      ...snapshot,
      runtimeState: "restarting",
      gatewayIssue: null,
      liveStatus: liveStatusFor({
        ...snapshot,
        runtimeState: "restarting",
      }),
    };
    emit({ type: "snapshot", snapshot });
    await startRuntime({ preserveSnapshot: true });
    return snapshot;
  }

  function manualCandidateById(candidateId: string) {
    return setupState.manualCandidates.find((candidate) => candidate.id === candidateId) ?? null;
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
    async startManualScan() {
      if (usesWindowsNativeGateway(process.platform)) {
        applyManualScanPayload({
          state: "scanning",
          pairingCandidateId: null,
          error: null,
          candidates: [],
        });

        if (child) {
          await sendGatewayCommand({ type: "start_manual_scan" });
          return setupState;
        }

        windowsScanRequested = true;
        await restartRuntime();
        return setupState;
      }

      await refreshAdapters();
      return setupState;
    },
    async pairManualCandidate(candidateId) {
      if (!candidateId) {
        return setupState;
      }

      const candidate = manualCandidateById(candidateId);

      if (!candidate) {
        throw new Error("That scan result is no longer available. Start a new manual scan.");
      }

      const nextApprovedNodes = dedupeApprovedNodes([
        ...setupState.approvedNodes,
        {
          id: candidate.id,
          label: candidate.label,
          peripheralId: candidate.peripheralId,
          address: candidate.address,
          localName: candidate.localName,
          knownDeviceId: candidate.knownDeviceId,
        },
      ]);

      store.setJson(APPROVED_NODES_KEY, nextApprovedNodes);
      setupState = {
        ...setupState,
        approvedNodes: nextApprovedNodes,
        manualScanState: "pairing",
        pairingCandidateId: candidateId,
        manualScanError: null,
      };
      emitSetup();

      if (pruneSnapshotToApprovedNodes(nextApprovedNodes)) {
        emit({ type: "snapshot", snapshot });
      }

      if (usesWindowsNativeGateway(process.platform)) {
        if (!child) {
          throw new Error("Windows BLE runtime is not running.");
        }

        await sendGatewayCommand({
          type: "set_allowed_nodes",
          nodes: nextApprovedNodes,
        });
        await sendGatewayCommand({
          type: "pair_manual_candidate",
          candidateId,
        });
        return setupState;
      }

      await refreshAdapters();
      return setupState;
    },
    async recoverApprovedNode(ruleId) {
      if (!ruleId) {
        return;
      }

      if (usesWindowsNativeGateway(process.platform)) {
        if (child) {
          await sendGatewayCommand({ type: "recover_approved_node", ruleId });
          return;
        }

        await restartRuntime();
        return;
      }

      await refreshAdapters();
    },
    async resumeApprovedNodeReconnect(ruleId) {
      if (!ruleId) {
        return;
      }

      if (usesWindowsNativeGateway(process.platform)) {
        if (child) {
          await sendGatewayCommand({ type: "resume_approved_node_reconnect", ruleId });
          return;
        }

        await restartRuntime();
        return;
      }

      await refreshAdapters();
    },
    async setAllowedNodes(nodes) {
      const nextNodes = dedupeApprovedNodes(nodes);
      store.setJson(APPROVED_NODES_KEY, nextNodes);
      setupState = {
        ...setupState,
        approvedNodes: nextNodes,
      };
      emitSetup();
      if (pruneSnapshotToApprovedNodes(nextNodes)) {
        emit({ type: "snapshot", snapshot });
      }
      await refreshAdapters();

      if (usesWindowsNativeGateway(process.platform)) {
        await sendGatewayCommand({
          type: "set_allowed_nodes",
          nodes: nextNodes,
        });
        return setupState;
      }

      await restartRuntime();
      return setupState;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
