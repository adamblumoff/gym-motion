/* global console, setTimeout */

import process from "node:process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BleAdapterSummary, DeviceSummary } from "@core/contracts";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.js";
import { createDesktopControlCommandHandler } from "./windows-winrt-gateway-control.js";
import {
  shouldWriteGatewayLog,
  shouldWriteSidecarLog,
} from "./windows-winrt-gateway-logging.js";
import {
  createGatewayConfig,
  parseApprovedNodeRules,
} from "./windows-winrt-gateway-config.js";
import {
  normalizeAllowedNodesPayload,
  describeNode,
} from "./windows-winrt-gateway-node.js";
import {
  applyNodeConnectionStateEvent,
  getGatewayConnectionState,
} from "./windows-winrt-gateway-connection.js";
import {
  handlePersistAck,
  sendToDesktop,
} from "./windows-winrt-gateway-desktop-ipc.js";
import {
  parseGatewayControlCommand,
  type GatewayChildRuntimeReadyMessage,
} from "../main/managed-gateway-runtime/gateway-child-ipc.js";
import { attachJsonLineReader } from "./windows-winrt-gateway-sidecar-io.js";
import { createTelemetryEventHandler } from "./windows-winrt-gateway-telemetry.js";
import type {
  GatewayDesktopMessage,
  GatewayDeviceContext,
  GatewayRuntimeServer,
  GatewaySidecarAdapterRecord,
  GatewaySidecarEvent,
} from "./windows-winrt-gateway-types.js";

const config = createGatewayConfig();

let approvedNodeRules = parseApprovedNodeRules(process.env.GATEWAY_APPROVED_NODE_RULES);
let latestDevicesMetadata: DeviceSummary[] = [];
let handleDesktopControlCommand:
  | ReturnType<typeof createDesktopControlCommandHandler>
  | null = null;

async function onControlCommand(command: unknown): Promise<Record<string, unknown> | void> {
  const parsed = parseGatewayControlCommand(command);
  if (!parsed || !handleDesktopControlCommand) {
    throw new Error("Invalid control command.");
  }

  const result = await handleDesktopControlCommand(parsed);
  return result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
}

const runtimeServer: GatewayRuntimeServer = createGatewayRuntimeServer({
  loadDevicesMetadata: async () => latestDevicesMetadata,
  runtimeHost: config.runtimeHost,
  runtimePort: config.runtimePort,
  onControlCommand,
  verbose: config.verbose,
});

let sidecar: ChildProcessWithoutNullStreams | null = null;
let shuttingDown = false;
let latestGatewayIssue = null;
let sidecarSessionStarted = false;
let scanRequestedFromBoot = config.startScanOnBoot;
let lastLoggedAdapterSnapshot = null;
const deviceContexts = new Map<string, GatewayDeviceContext>();
const liveTaskChains = new Map<string, Promise<void>>();

function log(message: string, details?: unknown) {
  if (!shouldWriteGatewayLog(message, config.verbose)) {
    return;
  }

  if (details !== undefined) {
    console.log(`[gateway-winrt] ${message}`, details);
    return;
  }

  console.log(`[gateway-winrt] ${message}`);
}

function debug(message: string, details?: unknown) {
  if (!config.verbose) {
    return;
  }

  log(message, details);
}

function emitDesktopMessage(message: GatewayDesktopMessage) {
  sendToDesktop(message, debug);
}

function emitGatewayState() {
  emitDesktopMessage({
    type: "gateway-state",
    gateway: runtimeServer.getGatewayState(),
    issue: latestGatewayIssue,
  });
}

function emitAdaptersUpdated() {
  emitDesktopMessage({
    type: "adapters-updated",
    adapters: runtimeServer.getAvailableAdapters(),
    issue: latestGatewayIssue,
  });
}

function emitRuntimeDeviceUpdated(deviceId: string | null | undefined) {
  if (!deviceId) {
    return;
  }

  const deviceSummary = runtimeServer.getDeviceSummary(deviceId);

  if (!deviceSummary) {
    return;
  }

  emitDesktopMessage({
    type: "runtime-device-updated",
    device: deviceSummary,
  });
}

function emitCurrentRuntimeDevices() {
  for (const device of runtimeServer.getDeviceSummaries()) {
    emitDesktopMessage({
      type: "runtime-device-updated",
      device,
    });
  }
}

function setRuntimeIssue(issue: string | null) {
  latestGatewayIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
  runtimeServer.setGatewayIssue(latestGatewayIssue);
  emitGatewayState();
}

function refreshAdapterIssue(adapters: BleAdapterSummary[]) {
  if (adapters.length === 0) {
    setRuntimeIssue("Bluetooth is unavailable on this machine.");
    return;
  }

  const availableAdapter = adapters.find((adapter) => adapter.isAvailable);
  if (!availableAdapter) {
    setRuntimeIssue(adapters[0]?.issue ?? "Bluetooth is unavailable on this machine.");
    return;
  }

  if (latestGatewayIssue?.startsWith("Bluetooth is unavailable")) {
    setRuntimeIssue(null);
  }
}

function sendCommand(type: string, payload: Record<string, unknown> = {}) {
  if (!sidecar?.stdin || sidecar.killed) {
    return;
  }

  sidecar.stdin.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function emitPersistMessage(type: "persist-motion", deviceId: string, payload: unknown) {
  sendToDesktop(
    {
      type,
      deviceId,
      payload,
    },
    debug,
  );
}

function queueTask(taskChains: Map<string, Promise<void>>, deviceId: string, work: () => Promise<void>) {
  const current = taskChains.get(deviceId) ?? Promise.resolve();
  const next = current.then(work, work);
  const tracked = next.catch(() => {});
  taskChains.set(deviceId, tracked);

  return next.finally(() => {
    if (taskChains.get(deviceId) === tracked) {
      taskChains.delete(deviceId);
    }
  });
}

function queueLiveDeviceTask(deviceId: string, work: () => Promise<void>) {
  return queueTask(liveTaskChains, deviceId, work);
}

function syncAllowedNodes() {
  sendCommand("set_allowed_nodes", {
    nodes: normalizeAllowedNodesPayload(approvedNodeRules),
  });
}

function requireSidecar(action: string) {
  if (!sidecar || sidecar.killed || !sidecar.stdin) {
    throw new Error(`Cannot ${action} because the Windows BLE sidecar is not running.`);
  }
}

const handleTelemetryEvent = createTelemetryEventHandler({
  runtimeServer,
  deviceContexts,
  emitGatewayState,
  emitRuntimeDeviceUpdated,
  emitPersistMessage,
  queueLiveDeviceTask,
  log,
  debug,
});

function normalizeManualScanPayload(): GatewayChildRuntimeReadyMessage["manualScan"] {
  const payload = runtimeServer.getManualScanPayload();
  return {
    ...payload,
    state:
      payload.state === "idle" ||
      payload.state === "scanning" ||
      payload.state === "pairing" ||
      payload.state === "failed"
        ? payload.state
        : undefined,
  };
}

handleDesktopControlCommand = createDesktopControlCommandHandler({
  runtimeServer,
  getApprovedNodeRules: () => approvedNodeRules,
  setApprovedNodeRules: (rules) => {
    approvedNodeRules = rules;
  },
  setLatestDevicesMetadata: (devices) => {
    latestDevicesMetadata = devices;
  },
  syncAllowedNodes,
  sendCommand,
  emitGatewayState,
  emitRuntimeDeviceUpdated,
  requireSidecar,
});

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function normalizeSidecarAdapters(adapters: GatewaySidecarAdapterRecord[] | null | undefined) {
  return Array.isArray(adapters)
    ? adapters.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        transport: adapter.transport ?? "winrt",
        runtimeDeviceId: null,
        isAvailable: adapter.is_available ?? adapter.isAvailable ?? false,
        issue: adapter.issue ?? null,
        details: Array.isArray(adapter.details)
          ? adapter.details.filter((detail): detail is string => typeof detail === "string")
          : [],
      }))
    : [];
}

function attachControlReader() {
  process.on("message", (input) => {
    if (handlePersistAck(input, debug)) {
      return;
    }

    const command = parseGatewayControlCommand(input);

    if (!command) {
      console.error("[gateway-winrt] ignored invalid control command", input);
      return;
    }

    const commandId = isRecord(input) && typeof input.commandId === "string"
      ? input.commandId
      : null;

    void handleDesktopControlCommand(command)
      .then((result) => {
        if (!commandId) {
          return;
        }

        emitDesktopMessage({
          type: "control-response",
          commandId,
          ok: true,
          result,
        });
      })
      .catch((error) => {
        console.error("[gateway-winrt] failed to handle control command", error);

        if (!commandId) {
          return;
        }

        emitDesktopMessage({
          type: "control-response",
          commandId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

function handleSidecarEvent(event: GatewaySidecarEvent) {
  switch (event.type) {
    case "ready":
      log("Windows BLE sidecar is ready.");
      break;
    case "adapter_list": {
      const adapters = normalizeSidecarAdapters(event.adapters);
      const adapterSnapshot = JSON.stringify(adapters);
      if (adapterSnapshot !== lastLoggedAdapterSnapshot) {
        lastLoggedAdapterSnapshot = adapterSnapshot;
        log(
          `received ${adapters.length} adapter${adapters.length === 1 ? "" : "s"} from sidecar`,
          adapters,
        );
      }

      runtimeServer.setAvailableAdapters(adapters);
      refreshAdapterIssue(adapters);
      emitAdaptersUpdated();
      emitGatewayState();

      if (!sidecarSessionStarted && adapters.length > 0) {
        sidecarSessionStarted = true;
        sendCommand("start");
      }

      if (scanRequestedFromBoot && adapters.length > 0) {
        scanRequestedFromBoot = false;
        sendCommand("rescan");
      }
      break;
    }
    case "gateway_state":
      runtimeServer.setAdapterState(
        event.gateway?.adapter_state ?? event.adapterState ?? "unknown",
      );
      runtimeServer.setScanState(
        event.gateway?.scan_state ?? event.scanState ?? "stopped",
        event.gateway?.scan_reason ?? event.scanReason ?? null,
      );
      setRuntimeIssue(event.gateway?.issue ?? event.issue ?? null);
      emitGatewayState();
      break;
    case "node_discovered": {
      const peripheralInfo = describeNode(event.node ?? {});
      runtimeServer.noteDiscovery({
        ...peripheralInfo,
        reconnectAttempt: null,
        reconnectAttemptLimit: null,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
      });
      emitGatewayState();
      emitRuntimeDeviceUpdated(runtimeServer.resolveKnownDeviceId(peripheralInfo));
      break;
    }
    case "node_connection_state":
      log("received node connection state", {
        state: getGatewayConnectionState(event),
        peripheralId: event.node?.peripheral_id ?? event.node?.peripheralId ?? null,
        knownDeviceId: event.node?.known_device_id ?? event.node?.knownDeviceId ?? null,
      });
      applyNodeConnectionStateEvent(event, {
        runtimeServer,
        deviceContexts,
        emitGatewayState,
        emitRuntimeDeviceUpdated,
      });
      break;
    case "telemetry":
      handleTelemetryEvent(event);
      break;
    case "log":
      if (
        shouldWriteSidecarLog(event.level ?? "info", event.message ?? "sidecar log", config.verbose)
      ) {
        log(event.message ?? "sidecar log", event.details);
      }
      break;
    case "error":
      setRuntimeIssue(event.message ?? "Windows BLE sidecar failed.");
      console.error("[gateway-winrt] sidecar error", event);
      break;
    default:
      debug("ignored sidecar event", event);
  }
}

async function startSidecar() {
  sidecarSessionStarted = false;
  scanRequestedFromBoot = config.startScanOnBoot;
  lastLoggedAdapterSnapshot = null;
  sidecar = spawn(config.sidecarPath, config.sidecarArgs ?? [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GATEWAY_VERBOSE: config.verbose ? "1" : "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  sidecar.stderr.on("data", (chunk) => {
    process.stderr.write(`[sidecar] ${chunk}`);
  });
  attachJsonLineReader(sidecar.stdout, handleSidecarEvent);
  sidecar.once("exit", (code, signal) => {
    sidecar = null;
    runtimeServer.setAdapterState("unknown");
    runtimeServer.setScanState("stopped", null);

    if (!shuttingDown) {
      setRuntimeIssue(`Windows BLE sidecar exited (${signal ?? code ?? "unknown"}).`);
    }

    emitAdaptersUpdated();
    emitGatewayState();
  });

  syncAllowedNodes();
  sendCommand("list_adapters");
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (sidecar) {
    const exitingSidecar = sidecar;
    sendCommand("shutdown");
    await Promise.race([
      new Promise((resolve) => {
        exitingSidecar.once("exit", resolve);
      }),
      new Promise((resolve) => {
        setTimeout(resolve, 1500);
      }),
    ]);

    if (!exitingSidecar.killed && exitingSidecar.exitCode === null) {
      exitingSidecar.kill("SIGTERM");
    }

    sidecar = null;
  }

  await runtimeServer.stop();
}

process.on("SIGTERM", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});
process.on("SIGINT", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});

attachControlReader();

void runtimeServer
  .start()
  .then(async () => {
    runtimeServer.setGatewayIssue("Starting Windows BLE runtime…");
    emitDesktopMessage({
      type: "runtime-ready",
      gateway: runtimeServer.getGatewayState(),
      issue: latestGatewayIssue,
      adapters: runtimeServer.getAvailableAdapters(),
      manualScan: normalizeManualScanPayload(),
    });
    emitCurrentRuntimeDevices();
    await startSidecar();
  })
  .catch((error) => {
    console.error("[gateway-winrt] failed to start Windows runtime", error);
    process.exitCode = 1;
  });
