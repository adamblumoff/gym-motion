// @ts-nocheck
/* global console, setTimeout */

import process from "node:process";
import { spawn } from "node:child_process";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.js";
import {
  shouldWriteGatewayLog,
  shouldWriteSidecarLog,
} from "./windows-winrt-gateway-logging.js";
import {
  createGatewayConfig,
  parseApprovedNodeRules,
  readSelectedAdapterId,
  selectPreferredAdapter,
} from "./windows-winrt-gateway-config.js";
import {
  approvedNodeRulesReferToSamePhysicalNode,
  createDeviceContext,
  normalizeAllowedNodesPayload,
  describeNode,
} from "./windows-winrt-gateway-node.js";
import {
  handlePersistAck,
  sendToDesktop,
} from "./windows-winrt-gateway-desktop-ipc.js";
import { attachJsonLineReader } from "./windows-winrt-gateway-sidecar-io.js";

const config = createGatewayConfig();

let approvedNodeRules = parseApprovedNodeRules(process.env.GATEWAY_APPROVED_NODE_RULES);
let selectedAdapterId = readSelectedAdapterId(process.env.GATEWAY_SELECTED_ADAPTER_ID);
let latestDevicesMetadata = [];

const runtimeServer = createGatewayRuntimeServer({
  loadDevicesMetadata: async () => latestDevicesMetadata,
  runtimeHost: config.runtimeHost,
  runtimePort: config.runtimePort,
  onControlCommand: handleDesktopControlCommand,
  verbose: config.verbose,
});

let sidecar = null;
let shuttingDown = false;
let latestGatewayIssue = null;
let sidecarSessionStarted = false;
let scanRequestedFromBoot = config.startScanOnBoot;
let currentScanReason = null;
let lastLoggedAdapterSnapshot = null;
const deviceContexts = new Map();
const liveTaskChains = new Map();

function log(message, details) {
  if (!shouldWriteGatewayLog(message, config.verbose)) {
    return;
  }

  if (details !== undefined) {
    console.log(`[gateway-winrt] ${message}`, details);
    return;
  }

  console.log(`[gateway-winrt] ${message}`);
}

function debug(message, details) {
  if (!config.verbose) {
    return;
  }

  log(message, details);
}

function emitDesktopMessage(message) {
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

function emitRuntimeDeviceUpdated(deviceId) {
  if (!deviceId) {
    return;
  }

  const runtimeNode = runtimeServer.getRuntimeNode(deviceId);

  if (!runtimeNode) {
    return;
  }

  emitDesktopMessage({
    type: "runtime-device-updated",
    device: {
      deviceId,
      ...runtimeNode,
      reconnectAwaitingDecision: runtimeNode.reconnectAwaitingDecision ?? false,
    },
  });
}

function emitCurrentRuntimeDevices() {
  for (const runtimeNode of runtimeServer.getRuntimeNodes()) {
    emitDesktopMessage({
      type: "runtime-device-updated",
      device: {
        ...runtimeNode,
        reconnectAwaitingDecision: runtimeNode.reconnectAwaitingDecision ?? false,
      },
    });
  }
}

function setRuntimeIssue(issue) {
  latestGatewayIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
  runtimeServer.setGatewayIssue(latestGatewayIssue);
  emitGatewayState();
}

function refreshSelectionIssue(adapters) {
  if (!selectedAdapterId) {
    setRuntimeIssue("Bluetooth is unavailable on this machine.");
    return;
  }

  const selectedAdapter = adapters.find((adapter) => adapter.id === selectedAdapterId);

  if (!selectedAdapter) {
    setRuntimeIssue("Bluetooth is unavailable on this machine.");
    return;
  }

  if (!selectedAdapter.isAvailable) {
    setRuntimeIssue(selectedAdapter.issue ?? "Bluetooth is unavailable on this machine.");
    return;
  }

  if (latestGatewayIssue?.startsWith("Bluetooth is unavailable")) {
    setRuntimeIssue(null);
  }
}

function sendCommand(type, payload = {}) {
  if (!sidecar?.stdin || sidecar.killed) {
    return;
  }

  sidecar.stdin.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function emitPersistMessage(type, deviceId, payload) {
  sendToDesktop(
    {
      type,
      deviceId,
      payload,
    },
    debug,
  );
}

function queueTask(taskChains, deviceId, work) {
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

function queueLiveDeviceTask(deviceId, work) {
  return queueTask(liveTaskChains, deviceId, work);
}

function syncAllowedNodes() {
  sendCommand("set_allowed_nodes", {
    nodes: normalizeAllowedNodesPayload(approvedNodeRules),
  });
}

function requireSidecar(action) {
  if (!sidecar || sidecar.killed || !sidecar.stdin) {
    throw new Error(`Cannot ${action} because the Windows BLE sidecar is not running.`);
  }
}

function applyNodeConnectionState(event) {
  const node = event.node ?? {};
  const connectionState =
    event.gateway_connection_state ??
    event.gatewayConnectionState ??
    "disconnected";
  const peripheralInfo = describeNode(node);
  const payload = {
    ...peripheralInfo,
    reconnectAttempt: null,
    reconnectAttemptLimit: null,
    reconnectRetryExhausted: false,
    reconnectAwaitingDecision: false,
  };

  const knownDeviceId =
    node.knownDeviceId ??
    node.known_device_id ??
    runtimeServer.resolveKnownDeviceId(peripheralInfo) ??
    null;
  if (knownDeviceId) {
    const context = deviceContexts.get(knownDeviceId) ?? createDeviceContext(knownDeviceId);
    context.lastGatewayConnectionState = connectionState;
    context.peripheralId = payload.peripheralId ?? context.peripheralId ?? null;
    context.address = payload.address ?? context.address ?? null;
    context.advertisedName = payload.localName ?? context.advertisedName ?? null;
    context.rssi = payload.rssi ?? context.rssi ?? null;
    deviceContexts.set(knownDeviceId, context);
  }

  if (connectionState === "connecting" || connectionState === "reconnecting") {
    runtimeServer.noteConnecting(payload);
  } else if (connectionState === "connected") {
    runtimeServer.noteConnected(payload);
  } else {
    runtimeServer.noteDisconnected({
      ...payload,
      reason: event.reason ?? "ble-disconnected",
    });
  }

  emitGatewayState();
  emitRuntimeDeviceUpdated(knownDeviceId ?? runtimeServer.resolveKnownDeviceId(peripheralInfo));
}

async function forwardTelemetryNow(event) {
  const rawPayload = event.payload_text ?? event.payloadText ?? null;
  if (typeof rawPayload !== "string" || rawPayload.length === 0) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    log("failed to parse telemetry payload", {
      error: error instanceof Error ? error.message : String(error),
      rawPayload,
    });
    return;
  }

  if (!payload?.deviceId || !payload?.state || !payload?.timestamp) {
    debug("ignored telemetry payload missing required fields", payload);
    return;
  }

  const node = describeNode(event.node ?? {});
  const context = deviceContexts.get(payload.deviceId) ?? createDeviceContext(payload.deviceId);
  const previousState = context.lastState;

  context.firmwareVersion = payload.firmwareVersion ?? context.firmwareVersion ?? "unknown";
  context.bootId = payload.bootId ?? context.bootId ?? null;
  context.hardwareId = payload.hardwareId ?? context.hardwareId ?? null;
  context.peripheralId = node.peripheralId ?? context.peripheralId ?? null;
  context.address = node.address ?? context.address ?? null;
  context.advertisedName = node.localName ?? context.advertisedName ?? null;
  context.rssi = node.rssi ?? context.rssi ?? null;
  context.lastGatewayConnectionState = "connected";
  deviceContexts.set(payload.deviceId, context);

  await runtimeServer.noteTelemetry(payload, {
    ...node,
    deviceId: payload.deviceId,
    knownDeviceId: payload.deviceId,
  });
  emitGatewayState();
  emitRuntimeDeviceUpdated(payload.deviceId);

  if (payload.snapshot === true) {
    context.lastState = payload.state;
    return;
  }

  if (previousState === payload.state) {
    context.lastState = payload.state;
    return;
  }

  emitPersistMessage("persist-motion", payload.deviceId, {
    deviceId: payload.deviceId,
    state: payload.state,
    timestamp: payload.timestamp,
    delta: payload.delta ?? null,
    sequence: payload.sequence,
    bootId: payload.bootId,
    firmwareVersion: payload.firmwareVersion,
    hardwareId: payload.hardwareId,
  });
  context.lastState = payload.state;
}

function handleTelemetryEvent(event) {
  const payloadDeviceId = (() => {
    const rawPayload = event.payload_text ?? event.payloadText ?? null;
    if (typeof rawPayload !== "string" || rawPayload.length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawPayload);
      return typeof parsed?.deviceId === "string" ? parsed.deviceId : null;
    } catch {
      return null;
    }
  })();

  if (!payloadDeviceId) {
    void forwardTelemetryNow(event);
    return;
  }

  void queueLiveDeviceTask(payloadDeviceId, () => forwardTelemetryNow(event));
}

function normalizeAdapterState(adapterState) {
  if (adapterState === "ready") {
    return "poweredOn";
  }

  return adapterState ?? "unknown";
}

async function handleDesktopControlCommand(command) {
  if (!command || typeof command !== "object") {
    throw new Error("Invalid control command.");
  }

  if (command.type === "set_devices_metadata") {
    latestDevicesMetadata = Array.isArray(command.devices)
      ? command.devices.filter(
          (device) => device && typeof device === "object" && typeof device.id === "string",
        )
      : [];

    for (const device of latestDevicesMetadata) {
      emitRuntimeDeviceUpdated(device.id);
    }
    emitGatewayState();

    return {
      deviceCount: latestDevicesMetadata.length,
    };
  }

  if (command.type !== "set_allowed_nodes" || !Array.isArray(command.nodes)) {
    throw new Error(`Unsupported control command: ${String(command.type ?? "unknown")}`);
  }

  requireSidecar("update approved nodes");

  const nextApprovedNodeRules = command.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
    address: node.address ?? null,
    localName: node.localName ?? node.local_name ?? null,
    knownDeviceId: node.knownDeviceId ?? node.known_device_id ?? null,
  }));
  const nextRuleIds = new Set(nextApprovedNodeRules.map((node) => node.id));
  const removedRules = approvedNodeRules.filter((node) => !nextRuleIds.has(node.id));
  const forgottenRules = removedRules.filter(
    (removedRule) =>
      !nextApprovedNodeRules.some((nextRule) =>
        approvedNodeRulesReferToSamePhysicalNode(removedRule, nextRule),
      ),
  );

  for (const rule of nextApprovedNodeRules) {
    runtimeServer.restoreApprovedDevice({
      deviceId: rule.knownDeviceId ?? null,
      knownDeviceId: rule.knownDeviceId ?? null,
      peripheralId: rule.peripheralId ?? null,
      address: rule.address ?? null,
      localName: rule.localName ?? null,
    });
  }

  for (const rule of forgottenRules) {
    runtimeServer.forgetDevice({
      deviceId: rule.knownDeviceId ?? null,
      knownDeviceId: rule.knownDeviceId ?? null,
      peripheralId: rule.peripheralId ?? null,
      address: rule.address ?? null,
      localName: rule.localName ?? null,
    });
  }

  approvedNodeRules = nextApprovedNodeRules;
  syncAllowedNodes();
  sendCommand("refresh_scan_policy");
  emitGatewayState();

  return {
    approvedCount: approvedNodeRules.length,
    removedCount: removedRules.length,
    forgottenCount: forgottenRules.length,
  };
}

function attachControlReader() {
  process.on("message", (command) => {
    if (handlePersistAck(command, debug)) {
      return;
    }

    if (!command || typeof command !== "object") {
      console.error("[gateway-winrt] ignored invalid control command", command);
      return;
    }

    const commandId = typeof command.commandId === "string" ? command.commandId : null;

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

function handleSidecarEvent(event) {
  switch (event.type) {
    case "ready":
      log("Windows BLE sidecar is ready.");
      break;
    case "adapter_list": {
      const adapters = Array.isArray(event.adapters)
        ? event.adapters.map((adapter) => ({
            id: adapter.id,
            label: adapter.label,
            transport: adapter.transport ?? "winrt",
            runtimeDeviceId: null,
            isAvailable: adapter.is_available ?? adapter.isAvailable ?? false,
            issue: adapter.issue ?? null,
            details: Array.isArray(adapter.details) ? adapter.details : [],
          }))
        : [];
      const adapterSnapshot = JSON.stringify(adapters);
      if (adapterSnapshot !== lastLoggedAdapterSnapshot) {
        lastLoggedAdapterSnapshot = adapterSnapshot;
        log(
          `received ${adapters.length} adapter${adapters.length === 1 ? "" : "s"} from sidecar`,
          adapters,
        );
      }

      if (!selectedAdapterId) {
        selectedAdapterId = selectPreferredAdapter(adapters);

        if (selectedAdapterId) {
          sendCommand("select_adapter", { adapter_id: selectedAdapterId });
        }
      }

      runtimeServer.setAvailableAdapters(adapters);
      refreshSelectionIssue(adapters);
      emitAdaptersUpdated();
      emitGatewayState();

      if (!sidecarSessionStarted && selectedAdapterId) {
        sidecarSessionStarted = true;
        sendCommand("start");
      }

      if (scanRequestedFromBoot && selectedAdapterId) {
        scanRequestedFromBoot = false;
        sendCommand("rescan");
      }
      break;
    }
    case "gateway_state":
      currentScanReason = event.gateway?.scan_reason ?? event.scanReason ?? null;
      runtimeServer.setAdapterState(
        normalizeAdapterState(event.gateway?.adapter_state ?? event.adapterState),
      );
      runtimeServer.setScanState(
        event.gateway?.scan_state ?? event.scanState ?? "stopped",
        currentScanReason,
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
        state:
          event.gateway_connection_state ??
          event.gatewayConnectionState ??
          "disconnected",
        peripheralId: event.node?.peripheral_id ?? event.node?.peripheralId ?? null,
        knownDeviceId: event.node?.known_device_id ?? event.node?.knownDeviceId ?? null,
      });
      applyNodeConnectionState(event);
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

  sidecar.stderr?.on("data", (chunk) => {
    process.stderr.write(`[sidecar] ${chunk}`);
  });
  attachJsonLineReader(sidecar.stdout, handleSidecarEvent);
  sidecar.once("exit", (code, signal) => {
    sidecar = null;
    currentScanReason = null;
    runtimeServer.setAdapterState("unknown");
    runtimeServer.setScanState("stopped", null);

    if (!shuttingDown) {
      setRuntimeIssue(`Windows BLE sidecar exited (${signal ?? code ?? "unknown"}).`);
    }

    emitAdaptersUpdated();
    emitGatewayState();
  });

  if (selectedAdapterId) {
    sendCommand("select_adapter", { adapter_id: selectedAdapterId });
  }
  syncAllowedNodes();
  sendCommand("list_adapters");
  if (selectedAdapterId) {
    sidecarSessionStarted = true;
    sendCommand("start");
  }
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
      manualScan: runtimeServer.getManualScanPayload(),
    });
    emitCurrentRuntimeDevices();
    await startSidecar();
  })
  .catch((error) => {
    console.error("[gateway-winrt] failed to start Windows runtime", error);
    process.exitCode = 1;
  });
