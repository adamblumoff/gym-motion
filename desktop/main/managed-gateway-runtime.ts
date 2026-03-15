import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { app } from "electron";
import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  DesktopSetupState,
  DesktopSnapshot,
  DiscoveredNodeSummary,
  DeviceActivitySummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
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
import {
  listDeviceActivity,
  listDeviceLogs,
  listRecentEvents,
} from "../../backend/data";
import type { PreferencesStore } from "./preferences-store";
import {
  createApprovedNodeRule,
  createNodeIdentity,
  matchesApprovedNodeRule,
} from "./setup-selection";

type ManagedGatewayRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<DesktopSnapshot>;
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSetupState: () => Promise<DesktopSetupState>;
  rescanAdapters: () => Promise<DesktopSetupState>;
  setAllowedNodes: (nodes: ApprovedNodeRule[]) => Promise<DesktopSetupState>;
  onEvent: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
};

const APPROVED_NODES_KEY = "gym-motion.desktop.approved-nodes";

const EMPTY_GATEWAY: GatewayStatusSummary = {
  hostname: "unavailable",
  mode: "reference-ble-node-gateway",
  sessionId: "unavailable",
  adapterState: "unknown",
  scanState: "stopped",
  connectedNodeCount: 0,
  reconnectingNodeCount: 0,
  knownNodeCount: 0,
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date().toISOString(),
  lastAdvertisementAt: null,
};

function createEmptySnapshot(): DesktopSnapshot {
  return {
    liveStatus: "Starting gateway runtime…",
    trayHint: "Closes to tray. Runtime stays hot.",
    runtimeState: "starting",
    gatewayIssue: null,
    gateway: { ...EMPTY_GATEWAY },
    devices: [],
    events: [],
    logs: [],
    activities: [],
  };
}

function offlineGatewaySnapshot() {
  return {
    ...EMPTY_GATEWAY,
    updatedAt: new Date().toISOString(),
  };
}

function degradedEmptySnapshot(issue: string): DesktopSnapshot {
  return {
    ...createEmptySnapshot(),
    liveStatus: "Gateway degraded",
    runtimeState: "degraded",
    gatewayIssue: issue,
    gateway: offlineGatewaySnapshot(),
  };
}

function createEmptySetupState(): DesktopSetupState {
  return {
    adapterIssue: null,
    approvedNodes: [],
    nodes: [],
  };
}

function normalizeGatewayHealth(payload: unknown) {
  const gateway = (payload as { gateway?: GatewayStatusSummary })?.gateway;
  return gateway ? { ...EMPTY_GATEWAY, ...gateway } : { ...EMPTY_GATEWAY };
}

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

function normalizeApprovedNodes(store: PreferencesStore) {
  const nodes = store.getJson<ApprovedNodeRule[]>(APPROVED_NODES_KEY);

  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.filter((node) => typeof node?.id === "string");
}

function dedupeApprovedNodes(nodes: ApprovedNodeRule[]) {
  const byId = new Map<string, ApprovedNodeRule>();

  for (const node of nodes) {
    byId.set(node.id, node);
  }

  return [...byId.values()];
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

  function sendWindowsGatewayCommand(command: Record<string, unknown>) {
    if (!usesWindowsNativeGateway(process.platform) || !child?.stdin || child.killed) {
      return;
    }

    child.stdin.write(`${JSON.stringify(command)}\n`);
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

  function liveStatusFor(snapshotState: DesktopSnapshot) {
    if (snapshotState.runtimeState === "starting") {
      return "Starting gateway runtime…";
    }

    if (snapshotState.runtimeState === "restarting") {
      return "Restarting gateway runtime…";
    }

    if (snapshotState.runtimeState === "degraded") {
      return "Gateway degraded";
    }

    if (snapshotState.gateway.connectedNodeCount > 0) {
      return "Gateway live";
    }

    if (
      snapshotState.gateway.scanState === "scanning" &&
      snapshotState.gateway.reconnectingNodeCount > 0
    ) {
      return "Reconnecting approved nodes";
    }

    if (snapshotState.gateway.scanState === "scanning") {
      return "Scanning for BLE nodes";
    }

    if (snapshotState.gateway.adapterState !== "poweredOn") {
      return "Waiting for BLE adapter";
    }

    return "Waiting for approved BLE nodes";
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
    return normalizeApprovedNodes(store);
  }

  function selectedAdapter() {
    return discoveredAdapters.find((adapter) => adapter.id === autoSelectedAdapterId) ?? null;
  }

  function applyAutoAdapterSelection(adapters: BleAdapterSummary[]) {
    if (usesWindowsNativeGateway(process.platform)) {
      return (
        adapters.find((adapter) => adapter.isAvailable)?.id ??
        adapters[0]?.id ??
        null
      );
    }

    const usableAdapters = adapters.filter(
      (adapter) => adapter.isAvailable && adapter.runtimeDeviceId !== null,
    );

    if (usableAdapters.length === 1) {
      return usableAdapters[0].id;
    }

    return null;
  }

  async function refreshAdapters() {
    const adapterPayload =
      usesWindowsNativeGateway(process.platform)
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
    const selectedAdapterId = applyAutoAdapterSelection(adapters);
    const adapterIssue = adapterPayload.error ??
      (adapters[0]?.id === "adapter-error"
      ? adapters[0].issue
      : selectedAdapterId && !adapters.some((adapter) => adapter.id === selectedAdapterId)
        ? "Bluetooth is unavailable on this machine."
        : adapters.length === 0
          ? usesWindowsNativeGateway(process.platform)
            ? "Bluetooth is unavailable on this machine."
            : "No compatible BLE adapters were detected."
          : usesWindowsNativeGateway(process.platform)
            ? null
            : selectedAdapterId
              ? null
              : "No compatible BLE adapters were detected.");

    discoveredAdapters = adapters;
    autoSelectedAdapterId = selectedAdapterId;

    setupState = {
      ...setupState,
      adapterIssue,
      approvedNodes: readApprovedNodes(),
    };

    emitSetup();

    if (
      usesWindowsNativeGateway(process.platform) &&
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

  function mergeSetupNodes(nodes: DiscoveredNodeSummary[]) {
    const approvedNodes = readApprovedNodes();
    const byId = new Map<string, DiscoveredNodeSummary>();

    for (const node of nodes) {
      byId.set(node.id, node);
    }

    for (const approvedNode of approvedNodes) {
      const matchingDevice = snapshot.devices.find((device) =>
        matchesApprovedNodeRule(approvedNode, {
          ...createNodeIdentity(device),
          knownDeviceId: device.id,
        }),
      );

      const alreadyPresent = [...byId.values()].some((node) =>
        matchesApprovedNodeRule(approvedNode, node),
      );

      if (!alreadyPresent) {
        byId.set(approvedNode.id, {
          id: approvedNode.id,
          label:
            matchingDevice?.machineLabel ??
            approvedNode.label ??
            approvedNode.localName ??
            approvedNode.knownDeviceId ??
            approvedNode.peripheralId ??
            "Approved node",
          peripheralId: approvedNode.peripheralId,
          address: approvedNode.address,
          localName: approvedNode.localName,
          knownDeviceId: approvedNode.knownDeviceId ?? matchingDevice?.id ?? null,
          machineLabel: matchingDevice?.machineLabel ?? null,
          siteId: matchingDevice?.siteId ?? null,
          lastRssi: matchingDevice?.lastRssi ?? null,
          lastSeenAt:
            matchingDevice?.gatewayLastAdvertisementAt ??
            matchingDevice?.gatewayLastTelemetryAt ??
            null,
          gatewayConnectionState: matchingDevice?.gatewayConnectionState ?? "visible",
          isApproved: true,
        });
      }
    }

    setupState = {
      ...setupState,
      approvedNodes,
      nodes: [...byId.values()].toSorted((left, right) => {
        const leftSeen = left.lastSeenAt ? new Date(left.lastSeenAt).getTime() : 0;
        const rightSeen = right.lastSeenAt ? new Date(right.lastSeenAt).getTime() : 0;
        return rightSeen - leftSeen;
      }),
    };

    emitSetup();
  }

  async function refreshSetupNodes() {
    if (!child) {
      mergeSetupNodes([]);
      return;
    }

    const discoveriesPayload = await fetchJson<{
      discoveries: Array<{
        id: string;
        peripheralId: string | null;
        address: string | null;
        localName: string | null;
        knownDeviceId: string | null;
        lastSeenAt: string | null;
        lastRssi: number | null;
      }>;
    }>(`http://127.0.0.1:${runtimePort}/discoveries`);

    const nodes = discoveriesPayload.discoveries.map((node) => {
      const matchingDevice =
        (node.knownDeviceId
          ? snapshot.devices.find((device) => device.id === node.knownDeviceId)
          : null) ??
        snapshot.devices.find((device) =>
          matchesApprovedNodeRule(
            createApprovedNodeRule({
              label: node.localName ?? node.peripheralId ?? "Visible node",
              peripheralId: node.peripheralId,
              address: node.address,
              localName: node.localName,
              knownDeviceId: node.knownDeviceId,
            }),
            {
              ...createNodeIdentity(device),
              knownDeviceId: device.id,
            },
          ),
        );
      const isApproved = readApprovedNodes().some((approvedNode) =>
        matchesApprovedNodeRule(approvedNode, node),
      );

      return {
        id: node.id,
        label:
          matchingDevice?.machineLabel ??
          node.localName ??
          node.knownDeviceId ??
          node.peripheralId ??
          "Visible node",
        peripheralId: node.peripheralId,
        address: node.address,
        localName: node.localName,
        knownDeviceId: node.knownDeviceId ?? matchingDevice?.id ?? null,
        machineLabel: matchingDevice?.machineLabel ?? null,
        siteId: matchingDevice?.siteId ?? null,
        lastRssi: node.lastRssi,
        lastSeenAt: node.lastSeenAt,
        gatewayConnectionState: matchingDevice?.gatewayConnectionState ?? "visible",
        isApproved,
      } satisfies DiscoveredNodeSummary;
    });

    mergeSetupNodes(nodes);
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
      mergeSetupNodes([]);
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

      if (usesWindowsNativeGateway(process.platform)) {
        await refreshAdapters();
      }

      await refreshSetupNodes();

      if (
        previousIds.size !== devicesPayload.devices.length ||
        devicesPayload.devices.some((device) => !previousIds.has(device.id))
      ) {
        await refreshHistory();
        emit({ type: "snapshot", snapshot });
        return;
      }

      for (const device of devicesPayload.devices) {
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
      env.GATEWAY_START_SCAN_ON_BOOT =
        windowsScanRequested || readApprovedNodes().length > 0 ? "1" : "0";
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
      case "motion-update":
        {
          const device = mergeRepositoryDeviceIntoGatewaySnapshot(
            snapshot.devices,
            event.payload.device,
          );
        snapshot = {
          ...snapshot,
          devices: mergeGatewayDeviceUpdate(snapshot.devices, device),
        };
        emit({
          type: "device-upserted",
          device,
        });
        if (event.payload.event) {
          snapshot = {
            ...snapshot,
            events: mergeEventUpdate(snapshot.events, event.payload.event, 14),
          };
          emit({ type: "event-recorded", event: event.payload.event });
          const activity: DeviceActivitySummary = {
            id: `motion-${event.payload.event.id}`,
            deviceId: event.payload.event.deviceId,
            sequence: event.payload.event.sequence,
            kind: "motion",
            title: event.payload.event.state.toUpperCase(),
            message: `Gateway recorded ${event.payload.event.state} for ${event.payload.event.deviceId}.`,
            state: event.payload.event.state,
            level: null,
            code: "motion.state",
            delta: event.payload.event.delta,
            eventTimestamp: event.payload.event.eventTimestamp,
            receivedAt: event.payload.event.receivedAt,
            bootId: event.payload.event.bootId,
            firmwareVersion: event.payload.event.firmwareVersion,
            hardwareId: event.payload.event.hardwareId,
            metadata:
              event.payload.event.delta === null
                ? null
                : { delta: event.payload.event.delta },
          };
          snapshot = {
            ...snapshot,
            activities: mergeActivityUpdate(snapshot.activities, activity, 30),
          };
          emit({ type: "activity-recorded", activity });
        }
        void refreshSetupNodes();
        break;
        }
      case "device-log": {
        const activity: DeviceActivitySummary = {
          id: `log-${event.payload.id}`,
          deviceId: event.payload.deviceId,
          sequence: event.payload.sequence,
          kind: "lifecycle",
          title: event.payload.code ?? event.payload.level.toUpperCase(),
          message: event.payload.message,
          state: null,
          level: event.payload.level,
          code: event.payload.code,
          delta: null,
          eventTimestamp: event.payload.deviceTimestamp,
          receivedAt: event.payload.receivedAt,
          bootId: event.payload.bootId,
          firmwareVersion: event.payload.firmwareVersion,
          hardwareId: event.payload.hardwareId,
          metadata: event.payload.metadata,
        };
        snapshot = {
          ...snapshot,
          logs: mergeLogUpdate(snapshot.logs, event.payload, 18),
          activities: mergeActivityUpdate(snapshot.activities, activity, 30),
        };
        emit({ type: "log-recorded", log: event.payload });
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
      mergeSetupNodes([]);
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
        await refreshSetupNodes();
      }
      return setupState;
    },
    async rescanAdapters() {
      if (usesWindowsNativeGateway(process.platform)) {
        windowsScanRequested = true;
        await restartRuntime();
        return setupState;
      }

      await refreshAdapters();
      return setupState;
    },
    async setAllowedNodes(nodes) {
      const nextNodes = dedupeApprovedNodes(nodes);
      store.setJson(APPROVED_NODES_KEY, nextNodes);
      await refreshAdapters();

      if (usesWindowsNativeGateway(process.platform)) {
        sendWindowsGatewayCommand({
          type: "set_allowed_nodes",
          nodes: nextNodes,
        });
        mergeSetupNodes(setupState.nodes);
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
