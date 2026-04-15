// @ts-nocheck
import process from "node:process";

import { attachJsonLineReader } from "./windows-winrt-gateway-sidecar-io.js";

const config = {
  simulator: process.env.GYM_MOTION_USB_BLE_BRIDGE_SIMULATOR === "1",
  serialPort: typeof process.env.GYM_MOTION_USB_BLE_BRIDGE_PORT === "string"
    ? process.env.GYM_MOTION_USB_BLE_BRIDGE_PORT.trim() || null
    : null,
  verbose: process.env.GATEWAY_VERBOSE === "1",
};

const DEFAULT_NODE = {
  ruleId: "bridge-rule-ac12c0",
  deviceId: "esp32-ac12c0",
  label: "Bridge Simulator Node",
  localName: "GymMotion-ac12c0",
  address: "AC:12:C0:00:00:01",
  peripheralId: "bridge-node-ac12c0",
  bootId: "bridge-boot-1",
  firmwareVersion: "bridge-sim-1.0.0",
  hardwareId: "bridge-sim",
  rssi: -48,
};

let selectedAdapterId = null;
let approvedNodes = [];
let started = false;
let scanState = "stopped";
let scanReason = null;
let manualScanState = {
  state: "idle",
  pairingCandidateId: null,
  error: null,
};
let connectedNode = null;
let telemetryTimer = null;
let pendingConnectTimer = null;
let pendingManualScanTimer = null;
let motionSequence = 0;
let lastMotionState = "still";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function log(message, details = undefined, level = "info") {
  emit({
    type: "log",
    level,
    message,
    details,
  });
}

function debug(message, details = undefined) {
  if (!config.verbose) {
    return;
  }

  log(message, details, "debug");
}

function clearTimer(timer) {
  if (timer !== null) {
    clearTimeout(timer);
  }

  return null;
}

function clearIntervalTimer(timer) {
  if (timer !== null) {
    clearInterval(timer);
  }

  return null;
}

function currentIssue() {
  if (config.simulator) {
    return null;
  }

  if (config.serialPort) {
    return `USB bridge port ${config.serialPort} is configured, but the serial bridge transport is not implemented yet.`;
  }

  return "No USB BLE bridge detected. Set GYM_MOTION_USB_BLE_BRIDGE_PORT or GYM_MOTION_USB_BLE_BRIDGE_SIMULATOR=1.";
}

function availableAdapters() {
  if (config.simulator) {
    return [
      {
        id: "bridge:simulator",
        label: "USB BLE Bridge Simulator",
        transport: "usb-bridge",
        is_available: true,
        issue: null,
        details: ["mode:simulator"],
      },
    ];
  }

  if (config.serialPort) {
    return [
      {
        id: `bridge:${config.serialPort.toLowerCase()}`,
        label: `USB BLE Bridge (${config.serialPort})`,
        transport: "usb-bridge",
        is_available: false,
        issue: currentIssue(),
        details: [`port:${config.serialPort}`],
      },
    ];
  }

  return [];
}

function adapterIsAvailable() {
  return availableAdapters().some(
    (adapter) => adapter.id === selectedAdapterId && adapter.is_available === true,
  );
}

function emitAdapterList() {
  emit({
    type: "adapter_list",
    adapters: availableAdapters(),
  });
}

function emitGatewayState() {
  const issue = currentIssue();
  emit({
    type: "gateway_state",
    gateway: {
      adapter_state: adapterIsAvailable() ? "poweredOn" : "unavailable",
      scan_state: started ? scanState : "stopped",
      scan_reason: started ? scanReason : null,
      issue,
    },
    issue,
  });
}

function emitManualScanState() {
  emit({
    type: "manual_scan_state",
    ...manualScanState,
  });
}

function resolveSimulatorIdentity() {
  const approvedNode = approvedNodes[0] ?? {};
  return {
    ruleId: approvedNode.id ?? DEFAULT_NODE.ruleId,
    deviceId: approvedNode.known_device_id ?? approvedNode.knownDeviceId ?? DEFAULT_NODE.deviceId,
    label: approvedNode.label ?? DEFAULT_NODE.label,
    localName: approvedNode.local_name ?? approvedNode.localName ?? DEFAULT_NODE.localName,
    address: approvedNode.address ?? DEFAULT_NODE.address,
    peripheralId: approvedNode.peripheral_id ?? approvedNode.peripheralId ?? DEFAULT_NODE.peripheralId,
    bootId: DEFAULT_NODE.bootId,
    firmwareVersion: DEFAULT_NODE.firmwareVersion,
    hardwareId: DEFAULT_NODE.hardwareId,
    rssi: DEFAULT_NODE.rssi,
  };
}

function emitNodeDiscovered(scanReasonOverride = "approved-reconnect") {
  const identity = resolveSimulatorIdentity();
  emit({
    type: "node_discovered",
    scan_reason: scanReasonOverride,
    node: {
      id: identity.ruleId,
      knownDeviceId: identity.deviceId,
      localName: identity.localName,
      address: identity.address,
      peripheralId: identity.peripheralId,
      lastRssi: identity.rssi,
      lastSeenAt: new Date().toISOString(),
      reconnect: {
        attempt: 1,
        attempt_limit: 20,
        retry_exhausted: false,
        awaiting_user_decision: false,
      },
    },
  });
}

function emitNodeConnectionState(state, reason = null) {
  const identity = resolveSimulatorIdentity();
  emit({
    type: "node_connection_state",
    gateway_connection_state: state,
    reason,
    boot_id: identity.bootId,
    node: {
      knownDeviceId: identity.deviceId,
      localName: identity.localName,
      address: identity.address,
      peripheralId: identity.peripheralId,
      lastRssi: identity.rssi,
    },
    reconnect: {
      attempt: 1,
      attempt_limit: 20,
      retry_exhausted: false,
      awaiting_user_decision: false,
    },
  });
}

function emitTelemetry() {
  if (!connectedNode) {
    return;
  }

  motionSequence += 1;
  lastMotionState = lastMotionState === "still" ? "moving" : "still";

  emit({
    type: "telemetry",
    node: {
      knownDeviceId: connectedNode.deviceId,
      localName: connectedNode.localName,
      address: connectedNode.address,
      peripheralId: connectedNode.peripheralId,
      lastRssi: connectedNode.rssi,
    },
    payload: {
      device_id: connectedNode.deviceId,
      state: lastMotionState,
      timestamp: new Date().toISOString(),
      delta: lastMotionState === "moving" ? 1 : 0,
      sequence: motionSequence,
      boot_id: connectedNode.bootId,
      firmware_version: connectedNode.firmwareVersion,
      hardware_id: connectedNode.hardwareId,
    },
  });
}

function startTelemetry() {
  telemetryTimer = clearIntervalTimer(telemetryTimer);
  telemetryTimer = setInterval(() => {
    emitTelemetry();
  }, 1_500);
  telemetryTimer.unref?.();
}

function stopTelemetry() {
  telemetryTimer = clearIntervalTimer(telemetryTimer);
}

function connectSimulatorNode(scanReasonOverride = "approved-reconnect") {
  if (!started || !adapterIsAvailable()) {
    return;
  }

  if (approvedNodes.length === 0 && scanReasonOverride !== "manual") {
    return;
  }

  pendingConnectTimer = clearTimer(pendingConnectTimer);

  emitNodeDiscovered(scanReasonOverride);
  emitNodeConnectionState("connecting");

  pendingConnectTimer = setTimeout(() => {
    connectedNode = resolveSimulatorIdentity();
    scanState = "stopped";
    scanReason = null;
    emitNodeConnectionState("connected");
    emitGatewayState();
    startTelemetry();
    log("USB BLE bridge simulator connected to approved node.", {
      deviceId: connectedNode.deviceId,
      localName: connectedNode.localName,
    });
  }, 250);
  pendingConnectTimer.unref?.();
}

function startApprovedReconnectFlow() {
  if (!adapterIsAvailable()) {
    emitGatewayState();
    return;
  }

  if (approvedNodes.length === 0) {
    scanState = "stopped";
    scanReason = null;
    emitGatewayState();
    return;
  }

  scanState = "scanning";
  scanReason = "approved-reconnect";
  emitGatewayState();

  if (config.simulator) {
    connectSimulatorNode("approved-reconnect");
  }
}

function startManualScanFlow() {
  if (!adapterIsAvailable()) {
    manualScanState = {
      state: "idle",
      pairingCandidateId: null,
      error: currentIssue(),
    };
    emitManualScanState();
    emitGatewayState();
    return;
  }

  manualScanState = {
    state: "scanning",
    pairingCandidateId: null,
    error: null,
  };
  emitManualScanState();

  if (!config.simulator) {
    return;
  }

  pendingManualScanTimer = clearTimer(pendingManualScanTimer);
  pendingManualScanTimer = setTimeout(() => {
    emitNodeDiscovered("manual");
  }, 150);
  pendingManualScanTimer.unref?.();
}

function disconnectSimulatorNode(reason = "bridge-reset") {
  pendingConnectTimer = clearTimer(pendingConnectTimer);
  pendingManualScanTimer = clearTimer(pendingManualScanTimer);
  stopTelemetry();

  if (!connectedNode) {
    return;
  }

  emitNodeConnectionState("disconnected", reason);
  connectedNode = null;
}

function handleSetAllowedNodes(command) {
  approvedNodes = Array.isArray(command.nodes) ? command.nodes : [];
  debug("Updated approved nodes for bridge sidecar.", {
    count: approvedNodes.length,
  });

  if (config.simulator && started) {
    disconnectSimulatorNode("approved-nodes-updated");
    startApprovedReconnectFlow();
  }
}

function handleSelectAdapter(command) {
  selectedAdapterId = typeof command.adapter_id === "string" ? command.adapter_id : null;
  debug("Selected USB bridge adapter.", {
    adapterId: selectedAdapterId,
  });
  emitGatewayState();
}

function handleStart() {
  started = true;
  startApprovedReconnectFlow();
}

function handleRescan() {
  disconnectSimulatorNode("rescan");
  startApprovedReconnectFlow();
}

function handlePairManualCandidate(command) {
  manualScanState = {
    state: "pairing",
    pairingCandidateId: command.candidate_id ?? null,
    error: null,
  };
  emitManualScanState();

  if (!config.simulator) {
    return;
  }

  pendingManualScanTimer = clearTimer(pendingManualScanTimer);
  pendingManualScanTimer = setTimeout(() => {
    manualScanState = {
      state: "idle",
      pairingCandidateId: null,
      error: null,
    };
    emitManualScanState();
    connectSimulatorNode("manual");
  }, 150);
  pendingManualScanTimer.unref?.();
}

function shutdown() {
  disconnectSimulatorNode("shutdown");
  process.exit(0);
}

function handleCommand(command) {
  switch (command.type) {
    case "list_adapters":
      emitAdapterList();
      emitGatewayState();
      return;
    case "select_adapter":
      handleSelectAdapter(command);
      return;
    case "set_allowed_nodes":
      handleSetAllowedNodes(command);
      return;
    case "start":
      handleStart();
      return;
    case "rescan":
      handleRescan();
      return;
    case "start_manual_scan":
      startManualScanFlow();
      return;
    case "pair_manual_candidate":
      handlePairManualCandidate(command);
      return;
    case "recover_approved_node":
    case "resume_approved_node_reconnect":
      handleRescan();
      return;
    case "shutdown":
      shutdown();
      return;
    default:
      log("Bridge sidecar ignored unsupported command.", {
        type: command.type ?? "unknown",
      }, "warn");
  }
}

process.stdin.resume();
attachJsonLineReader(process.stdin, handleCommand);

emit({ type: "ready" });
log("USB BLE bridge sidecar started.", {
  simulator: config.simulator,
  serialPort: config.serialPort,
});
