/* global console, setTimeout */

import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.mjs";
import { shouldWriteSidecarLog } from "./windows-winrt-gateway-logging.mjs";
import {
  createGatewayConfig,
  parseApprovedNodeRules,
  readSelectedAdapterId,
  selectPreferredAdapter,
} from "./windows-winrt-gateway-config.mjs";
import {
  approvedNodeRulesReferToSamePhysicalNode,
  normalizeAllowedNodesPayload,
} from "./windows-winrt-gateway-node.mjs";
import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge.mjs";
import { attachJsonLineReader } from "./windows-winrt-gateway-sidecar-io.mjs";

const config = createGatewayConfig();

let approvedNodeRules = parseApprovedNodeRules(process.env.GATEWAY_APPROVED_NODE_RULES);
let selectedAdapterId = readSelectedAdapterId(process.env.GATEWAY_SELECTED_ADAPTER_ID);

const runtimeServer = createGatewayRuntimeServer({
  apiBaseUrl: config.apiBaseUrl,
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

const runtimeBridge = createRuntimeBridge({
  config,
  runtimeServer,
  debug,
});

function setRuntimeIssue(issue) {
  latestGatewayIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
  runtimeServer.setGatewayIssue(latestGatewayIssue);
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
    return {
      approvedCount: approvedNodeRules.length,
      removedCount: removedRules.length,
      forgottenCount: forgottenRules.length,
    };
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
    sendCommand("rescan");
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
    sendCommand("resume_approved_node_reconnect", {
      rule_id: command.ruleId,
    });
    return { ruleId: command.ruleId };
  }

  throw new Error(`Unsupported control command: ${String(command.type ?? "unknown")}`);
}

function attachControlReader() {
  const controlReader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  controlReader.on("line", (line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    let command;
    try {
      command = JSON.parse(trimmed);
    } catch (error) {
      console.error("[gateway-winrt] failed to parse control command", error);
      return;
    }

    void handleDesktopControlCommand(command).catch((error) => {
      console.error("[gateway-winrt] failed to handle control command", error);
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
      break;
    case "node_connection_state":
      runtimeBridge.handleNodeConnectionState(event);
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

      void runtimeBridge.forwardTelemetry(payload, event.node ?? {}).catch((error) => {
        console.error("[gateway-winrt] failed to forward telemetry", error);
        setRuntimeIssue(error instanceof Error ? error.message : "Telemetry forwarding failed.");
      });
      break;
    }
    case "log":
      if (
        shouldWriteSidecarLog(event.level ?? "info", event.message ?? "sidecar log", config.verbose)
      ) {
        log(event.message ?? "sidecar log", event.details);
        runtimeBridge.handleSidecarLog(event);
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
    await startSidecar();
  })
  .catch((error) => {
    console.error("[gateway-winrt] failed to start Windows runtime", error);
    process.exitCode = 1;
  });
