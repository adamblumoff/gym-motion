// @ts-nocheck
/* global console, setTimeout */

import process from "node:process";
import { spawn } from "node:child_process";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.js";
import { shouldWriteSidecarLog } from "./windows-winrt-gateway-logging.js";
import {
  createGatewayConfig,
  parseApprovedNodeRules,
  readSelectedAdapterId,
  selectPreferredAdapter,
} from "./windows-winrt-gateway-config.js";
import {
  approvedNodeRulesReferToSamePhysicalNode,
  normalizeAllowedNodesPayload,
  describeNode,
} from "./windows-winrt-gateway-node.js";
import {
  handlePersistAck,
  sendToDesktop,
} from "./windows-winrt-gateway-desktop-ipc.js";
import { createNodeConnectionStateEventQueue } from "./windows-winrt-gateway-node-connection-state.js";
import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge.js";
import { attachJsonLineReader } from "./windows-winrt-gateway-sidecar-io.js";

const config = createGatewayConfig();

let approvedNodeRules = parseApprovedNodeRules(process.env.GATEWAY_APPROVED_NODE_RULES);
let selectedAdapterId = readSelectedAdapterId(process.env.GATEWAY_SELECTED_ADAPTER_ID);
let pushedMetadataDevices = [];

const runtimeServer = createGatewayRuntimeServer({
  loadDevicesMetadata: async () => pushedMetadataDevices,
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

function log(message, details) {
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

function emitManualScanUpdated() {
  emitDesktopMessage({
    type: "manual-scan-updated",
    payload: runtimeServer.getManualScanPayload(),
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

const runtimeBridge = createRuntimeBridge({
  config,
  runtimeServer,
  debug,
  sendSidecarCommand(command) {
    sendCommand(command.type, command);
  },
});

const enqueueNodeConnectionStateEvent = createNodeConnectionStateEventQueue({
  runtimeBridge,
  runtimeServer,
  emitGatewayState,
  emitRuntimeDeviceUpdated,
  onError(error) {
    console.error("[gateway-winrt] failed to handle node connection state", error);
    setRuntimeIssue(
      error instanceof Error ? error.message : "Node connection-state handling failed.",
    );
  },
});

function setRuntimeIssue(issue) {
  latestGatewayIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
  runtimeServer.setGatewayIssue(latestGatewayIssue);
  emitGatewayState();
}

function setManualScanState({
  state,
  pairingCandidateId = null,
  error = null,
  clearCandidates = false,
}) {
  runtimeServer.setManualScanState({
    state,
    pairingCandidateId,
    error,
    clearCandidates,
  });
  emitManualScanUpdated();
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

function sidecarAllowedNodesPayload() {
  return normalizeAllowedNodesPayload(approvedNodeRules);
}

function syncAllowedNodes() {
  sendCommand("set_allowed_nodes", {
    nodes: sidecarAllowedNodesPayload(),
  });
}

function requireSidecar(action) {
  if (!sidecar || sidecar.killed || !sidecar.stdin) {
    throw new Error(`Cannot ${action} because the Windows BLE sidecar is not running.`);
  }
}

async function handleDesktopControlCommand(command) {
  if (!command || typeof command !== "object") {
    throw new Error("Invalid control command.");
  }

  if (command.type === "set_allowed_nodes" && Array.isArray(command.nodes)) {
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
    log("Approved-node rules updated from desktop runtime.", {
      approvedCount: approvedNodeRules.length,
      removedCount: removedRules.length,
      forgottenCount: forgottenRules.length,
    });
    syncAllowedNodes();
    emitGatewayState();
    return {
      approvedCount: approvedNodeRules.length,
      removedCount: removedRules.length,
      forgottenCount: forgottenRules.length,
    };
  }

  if (command.type === "set_devices_metadata" && Array.isArray(command.devices)) {
    pushedMetadataDevices = command.devices.filter(
      (device) => device && typeof device === "object" && typeof device.id === "string",
    );
    emitGatewayState();
    return { deviceCount: pushedMetadataDevices.length };
  }

  if (command.type === "start_manual_scan") {
    requireSidecar("start a manual scan");
    setManualScanState({
      state: "scanning",
      pairingCandidateId: null,
      error: null,
      clearCandidates: true,
    });
    log("Manual scan requested from desktop runtime.");
    syncAllowedNodes();
    sendCommand("start_manual_scan");
    return { state: "scanning" };
  }

  if (command.type === "pair_manual_candidate" && typeof command.candidateId === "string") {
    requireSidecar("pair a manual scan candidate");
    setManualScanState({
      state: "pairing",
      pairingCandidateId: command.candidateId,
      error: null,
    });
    sendCommand("pair_manual_candidate", {
      candidate_id: command.candidateId,
    });
    return {
      state: "pairing",
      pairingCandidateId: command.candidateId,
    };
  }

  if (command.type === "recover_approved_node" && typeof command.ruleId === "string") {
    requireSidecar("recover an approved node");
    sendCommand("recover_approved_node", {
      rule_id: command.ruleId,
    });
    return { ruleId: command.ruleId };
  }

  if (
    command.type === "resume_approved_node_reconnect" &&
    typeof command.ruleId === "string"
  ) {
    requireSidecar("resume approved-node reconnect");
    const rule = approvedNodeRules.find((node) => node.id === command.ruleId);
    log("Resuming paused approved-node reconnect scan.", {
      ruleId: command.ruleId,
      knownDeviceId: rule?.knownDeviceId ?? null,
      peripheralId: rule?.peripheralId ?? null,
      address: rule?.address ?? null,
    });
    runtimeServer.clearReconnectDecision({
      knownDeviceId: rule?.knownDeviceId ?? null,
      peripheralId: rule?.peripheralId ?? null,
      address: rule?.address ?? null,
      localName: rule?.localName ?? null,
    });
    emitRuntimeDeviceUpdated(rule?.knownDeviceId ?? null);
    sendCommand("resume_approved_node_reconnect", {
      rule_id: command.ruleId,
    });
    return { ruleId: command.ruleId };
  }

  throw new Error(`Unsupported control command: ${String(command.type ?? "unknown")}`);
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
        log(`received ${adapters.length} adapter${adapters.length === 1 ? "" : "s"} from sidecar`, adapters);
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
        event.gateway?.adapter_state ?? event.adapterState ?? "unknown",
      );
      runtimeServer.setScanState(
        event.gateway?.scan_state ?? event.scanState ?? "stopped",
        currentScanReason,
      );
      setRuntimeIssue(event.gateway?.issue ?? event.issue ?? null);
      emitGatewayState();
      break;
    case "manual_scan_state":
      setManualScanState({
        state: event.state ?? "idle",
        pairingCandidateId: event.candidate_id ?? event.candidateId ?? null,
        error: event.error ?? null,
        clearCandidates: (event.state ?? "idle") === "idle",
      });
      break;
    case "node_discovered":
      runtimeBridge.handleNodeDiscovered(
        event.node ?? {},
        event.scan_reason ?? event.scanReason ?? null,
      );
      emitManualScanUpdated();
      emitGatewayState();
      emitRuntimeDeviceUpdated(runtimeServer.resolveKnownDeviceId(describeNode(event.node ?? {})));
      break;
    case "node_connection_state":
      log("received node connection state", {
        state:
          event.gateway_connection_state ??
          event.gatewayConnectionState ??
          "disconnected",
        peripheralId: event.node?.peripheral_id ?? event.node?.peripheralId ?? null,
        knownDeviceId: event.node?.known_device_id ?? event.node?.knownDeviceId ?? null,
        bootId: event.boot_id ?? event.bootId ?? null,
      });
      void enqueueNodeConnectionStateEvent(event);
      break;
    case "telemetry": {
      const payload = {
        deviceId: event.payload?.device_id ?? event.payload?.deviceId,
        state: event.payload?.state,
        timestamp: event.payload?.timestamp,
        delta: event.payload?.delta ?? null,
        sequence: event.payload?.sequence,
        bootId: event.payload?.boot_id ?? event.payload?.bootId,
        firmwareVersion: event.payload?.firmware_version ?? event.payload?.firmwareVersion,
        hardwareId: event.payload?.hardware_id ?? event.payload?.hardwareId,
      };

      if (!payload.deviceId || !payload.state || !payload.timestamp) {
        setRuntimeIssue("Windows BLE sidecar emitted an invalid telemetry payload.");
        break;
      }

      void runtimeBridge
        .forwardTelemetry(payload, event.node ?? {})
        .then(() => {
          emitRuntimeDeviceUpdated(payload.deviceId);
          emitGatewayState();
        })
        .catch((error) => {
          console.error("[gateway-winrt] failed to forward telemetry", error);
          setRuntimeIssue(error instanceof Error ? error.message : "Telemetry forwarding failed.");
        });
      break;
    }
    case "history_record":
      log("received history record", {
        deviceId: event.device_id ?? null,
        requestId: event.request_id ?? null,
        sequence: event.record?.sequence ?? null,
        kind: event.record?.kind ?? null,
      });
      void runtimeBridge.handleHistoryRecord({
        device_id: event.device_id,
        request_id: event.request_id,
        node: event.node ?? {},
        record: event.record,
      }).catch((error) => {
        console.error("[gateway-winrt] failed to buffer history record", error);
        setRuntimeIssue(error instanceof Error ? error.message : "History record buffering failed.");
      });
      break;
    case "history_sync_complete":
      log("received history sync completion", {
        deviceId: event.payload?.device_id ?? event.payload?.deviceId ?? null,
        latestSequence:
          event.payload?.latest_sequence ?? event.payload?.latestSequence ?? null,
        requestId: event.payload?.request_id ?? event.payload?.requestId ?? null,
        highWaterSequence:
          event.payload?.high_water_sequence ?? event.payload?.highWaterSequence ?? null,
        sentCount: event.payload?.sent_count ?? event.payload?.sentCount ?? null,
        hasMore: event.payload?.has_more ?? event.payload?.hasMore ?? null,
      });
      void runtimeBridge
        .handleHistorySyncComplete({
          node: event.node ?? {},
          payload: event.payload ?? {},
        })
        .catch((error) => {
          console.error("[gateway-winrt] failed to complete history sync page", error);
          setRuntimeIssue(error instanceof Error ? error.message : "History sync failed.");
        });
      break;
    case "history_error":
      log("received history sync error", {
        deviceId: event.payload?.device_id ?? event.payload?.deviceId ?? null,
        requestId: event.payload?.request_id ?? event.payload?.requestId ?? null,
        code: event.payload?.code ?? null,
        detail: event.payload?.message ?? null,
      });
      void runtimeBridge
        .handleHistoryError({
          node: event.node ?? {},
          payload: event.payload ?? {},
        })
        .then(() => {
          emitDesktopMessage({
            type: "history_error",
            node: event.node ?? {},
            payload: event.payload ?? {},
          });
        })
        .catch((error) => {
          console.error("[gateway-winrt] failed to process history sync error", error);
          setRuntimeIssue(
            error instanceof Error ? error.message : "History sync failure handling failed.",
          );
        });
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
  setManualScanState({
    state: "idle",
    pairingCandidateId: null,
    error: null,
    clearCandidates: true,
  });
  sidecar = spawn(config.sidecarPath, [], {
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
    setManualScanState({
      state: "idle",
      pairingCandidateId: null,
      error: null,
      clearCandidates: true,
    });

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
