// @ts-nocheck
import process from "node:process";

import { sendToDesktop } from "../scripts/windows-winrt-gateway-desktop-ipc.js";

const DEFAULT_NODE = {
  ruleId: "rule-f4e9d4",
  candidateId: "candidate-f4e9d4",
  deviceId: "esp32-085ab2f4e9d4",
  label: "Leg Press Sensor",
  localName: "GymMotion-f4e9d4",
  address: "D4:E9:F4:B2:5A:0A",
  peripheralId: "D4:E9:F4:B2:5A:0A",
  bootId: "boot-e2e-1",
  firmwareVersion: "1.0.0-e2e",
  hardwareId: "hw-e2e-1",
  rssi: -58,
  machineLabel: "Leg Press",
  siteId: "Dallas",
};

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function log(...parts) {
  process.stdout.write(`[fake-gateway-child] ${parts.join(" ")}\n`);
}

function parseApprovedRules() {
  const raw = process.env.GATEWAY_APPROVED_NODE_RULES;
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    log(
      "failed to parse GATEWAY_APPROVED_NODE_RULES:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

let approvedRules = parseApprovedRules();
let adapterState = "poweredOn";
let scanState = approvedRules.length > 0 ? "scanning" : "stopped";
let scanReason = approvedRules.length > 0 ? "approved-reconnect" : null;
let gatewayStartedAt = nowIso();
let gatewayLastAdvertisementAt = null;
let manualScan = {
  state: "idle",
  pairingCandidateId: null,
  error: null,
  candidates: [],
};
let runtimeDevice = approvedRules.length > 0 ? createRuntimeDevice("disconnected") : null;
let motionSequence = 0;
let logSequence = 0;

function currentIdentity() {
  const approvedRule = approvedRules[0] ?? null;
  return {
    ruleId: approvedRule?.id ?? DEFAULT_NODE.ruleId,
    candidateId: DEFAULT_NODE.candidateId,
    deviceId: approvedRule?.knownDeviceId ?? DEFAULT_NODE.deviceId,
    label: approvedRule?.label ?? DEFAULT_NODE.label,
    localName: approvedRule?.localName ?? DEFAULT_NODE.localName,
    address: approvedRule?.address ?? DEFAULT_NODE.address,
    peripheralId: approvedRule?.peripheralId ?? DEFAULT_NODE.peripheralId,
    bootId: DEFAULT_NODE.bootId,
    firmwareVersion: DEFAULT_NODE.firmwareVersion,
    hardwareId: DEFAULT_NODE.hardwareId,
    machineLabel: DEFAULT_NODE.machineLabel,
    siteId: DEFAULT_NODE.siteId,
    rssi: DEFAULT_NODE.rssi,
  };
}

function currentCandidate() {
  const identity = currentIdentity();
  return {
    id: identity.candidateId,
    label: identity.label,
    peripheralId: identity.peripheralId,
    address: identity.address,
    localName: identity.localName,
    knownDeviceId: identity.deviceId,
    machineLabel: identity.machineLabel,
    siteId: identity.siteId,
    lastRssi: identity.rssi,
    lastSeenAt: nowIso(),
  };
}

function createRuntimeDevice(connectionState, overrides = {}) {
  const identity = currentIdentity();
  const timestamp = nowIso();
  return {
    deviceId: identity.deviceId,
    gatewayConnectionState: connectionState,
    peripheralId: identity.peripheralId,
    address: identity.address,
    gatewayLastAdvertisementAt:
      overrides.gatewayLastAdvertisementAt ?? gatewayLastAdvertisementAt,
    gatewayLastConnectedAt:
      overrides.gatewayLastConnectedAt ??
      (connectionState === "connected" ? timestamp : null),
    gatewayLastDisconnectedAt:
      connectionState === "connected" ? null : overrides.gatewayLastDisconnectedAt ?? timestamp,
    gatewayLastTelemetryAt: overrides.gatewayLastTelemetryAt ?? null,
    gatewayDisconnectReason:
      overrides.gatewayDisconnectReason ?? (connectionState === "connected" ? null : "link lost"),
    advertisedName: identity.localName,
    lastRssi: identity.rssi,
    lastState: overrides.lastState ?? "still",
    lastSeenAt: overrides.lastSeenAt ?? nowMs(),
    lastDelta: overrides.lastDelta ?? null,
    firmwareVersion: identity.firmwareVersion,
    bootId: identity.bootId,
    hardwareId: identity.hardwareId,
    otaStatus: "idle",
    otaTargetVersion: null,
    otaProgressBytesSent: null,
    otaTotalBytes: null,
    otaLastPhase: null,
    otaFailureDetail: null,
    otaLastStatusMessage: null,
    otaUpdatedAt: null,
    reconnectAttempt: overrides.reconnectAttempt ?? 0,
    reconnectAttemptLimit: overrides.reconnectAttemptLimit ?? 20,
    reconnectRetryExhausted: overrides.reconnectRetryExhausted ?? false,
    reconnectAwaitingDecision: overrides.reconnectAwaitingDecision ?? false,
    updatedAt: timestamp,
  };
}

function currentGateway() {
  return {
    hostname: "e2e-desktop",
    mode: "reference-ble-node-gateway",
    sessionId: "e2e-session",
    adapterState,
    scanState,
    scanReason,
    connectedNodeCount: runtimeDevice?.gatewayConnectionState === "connected" ? 1 : 0,
    reconnectingNodeCount: runtimeDevice?.gatewayConnectionState === "reconnecting" ? 1 : 0,
    knownNodeCount: approvedRules.length,
    startedAt: gatewayStartedAt,
    updatedAt: nowIso(),
    lastAdvertisementAt: gatewayLastAdvertisementAt,
  };
}

function sendRuntime(message) {
  sendToDesktop(message, log);
}

function emitGatewayState() {
  sendRuntime({
    type: "gateway-state",
    gateway: currentGateway(),
    issue: null,
  });
}

function emitAdapters() {
  sendRuntime({
    type: "adapters-updated",
    adapters: [
      {
        id: "winrt:0",
        label: "Bluetooth",
        transport: "winrt",
        runtimeDeviceId: null,
        isAvailable: adapterState === "poweredOn",
        issue: adapterState === "poweredOn" ? null : `adapter-${adapterState}`,
        details: [`state:${adapterState}`],
      },
    ],
    issue: null,
  });
}

function emitManualScan() {
  sendRuntime({
    type: "manual-scan-updated",
    payload: clone(manualScan),
  });
}

function emitRuntimeDevice() {
  if (!runtimeDevice) {
    return;
  }

  sendRuntime({
    type: "runtime-device-updated",
    device: clone(runtimeDevice),
  });
}

function respond(command, ok, resultOrError) {
  if (typeof command?.commandId !== "string") {
    return;
  }

  sendRuntime({
    type: "control-response",
    commandId: command.commandId,
    ok,
    ...(ok ? { result: resultOrError } : { error: String(resultOrError ?? "Unknown error") }),
  });
}

function refreshApprovedReconnectState() {
  if (approvedRules.length === 0) {
    if (scanReason === "approved-reconnect") {
      scanState = "stopped";
      scanReason = null;
    }
    return;
  }

  if (
    runtimeDevice &&
    (runtimeDevice.gatewayConnectionState === "connected" ||
      runtimeDevice.gatewayConnectionState === "reconnecting")
  ) {
    return;
  }

  scanState = "scanning";
  scanReason = "approved-reconnect";
}

function syncRuntimeIdentityFromApprovedRules() {
  if (!runtimeDevice) {
    if (approvedRules.length > 0) {
      runtimeDevice = createRuntimeDevice("disconnected", {
        gatewayDisconnectReason: "awaiting-approved-reconnect",
      });
    }
    return;
  }

  const identity = currentIdentity();
  runtimeDevice = {
    ...runtimeDevice,
    deviceId: identity.deviceId,
    peripheralId: identity.peripheralId,
    address: identity.address,
    advertisedName: identity.localName,
    firmwareVersion: identity.firmwareVersion,
    bootId: identity.bootId,
    hardwareId: identity.hardwareId,
    lastRssi: identity.rssi,
    updatedAt: nowIso(),
  };
}

function setDisconnected(reason = "link lost", overrides = {}) {
  runtimeDevice = createRuntimeDevice("disconnected", {
    lastState: runtimeDevice?.lastState ?? "still",
    lastSeenAt: runtimeDevice?.lastSeenAt ?? nowMs(),
    lastDelta: runtimeDevice?.lastDelta ?? null,
    gatewayLastConnectedAt: runtimeDevice?.gatewayLastConnectedAt ?? null,
    gatewayLastTelemetryAt: runtimeDevice?.gatewayLastTelemetryAt ?? null,
    gatewayLastDisconnectedAt: nowIso(),
    gatewayDisconnectReason: reason,
    ...overrides,
  });
  refreshApprovedReconnectState();
  emitRuntimeDevice();
  emitGatewayState();
}

function setConnected() {
  runtimeDevice = createRuntimeDevice("connected", {
    lastState: runtimeDevice?.lastState ?? "still",
    lastSeenAt: runtimeDevice?.lastSeenAt ?? nowMs(),
    lastDelta: runtimeDevice?.lastDelta ?? null,
    gatewayLastTelemetryAt: runtimeDevice?.gatewayLastTelemetryAt ?? null,
  });
  scanState = "stopped";
  scanReason = null;
  emitRuntimeDevice();
  emitGatewayState();
}

function showCandidate() {
  gatewayLastAdvertisementAt = nowIso();
  scanState = "scanning";
  scanReason = "manual";
  manualScan = {
    state: "scanning",
    pairingCandidateId: null,
    error: null,
    candidates: [currentCandidate()],
  };
  emitGatewayState();
  emitManualScan();
}

function clearManualScan() {
  manualScan = {
    state: "idle",
    pairingCandidateId: null,
    error: null,
    candidates: [],
  };
  emitManualScan();
}

function sendPersistMotion(state, delta = null) {
  motionSequence += 1;
  const identity = currentIdentity();
  const timestamp = nowMs();
  runtimeDevice = {
    ...(runtimeDevice ?? createRuntimeDevice("disconnected")),
    lastState: state,
    lastSeenAt: timestamp,
    lastDelta: delta,
    gatewayLastTelemetryAt: nowIso(),
    updatedAt: nowIso(),
  };
  emitRuntimeDevice();
  sendToDesktop(
    {
      type: "persist-motion",
      deviceId: identity.deviceId,
      payload: {
        deviceId: identity.deviceId,
        state,
        timestamp,
        delta,
        sequence: motionSequence,
        bootId: identity.bootId,
        firmwareVersion: identity.firmwareVersion,
        hardwareId: identity.hardwareId,
      },
    },
    log,
  );
}

function sendDeviceLog(level, code, message) {
  logSequence += 1;
  const identity = currentIdentity();
  sendToDesktop(
    {
      type: "persist-device-log",
      deviceId: identity.deviceId,
      payload: {
        deviceId: identity.deviceId,
        level,
        code,
        message,
        sequence: logSequence,
        bootId: identity.bootId,
        firmwareVersion: identity.firmwareVersion,
        hardwareId: identity.hardwareId,
        timestamp: nowMs(),
      },
    },
    log,
  );
}

function applyStep(name) {
  switch (name) {
    case "announceCandidate":
      showCandidate();
      return { ok: true };
    case "connectApprovedNode":
      syncRuntimeIdentityFromApprovedRules();
      setConnected();
      sendDeviceLog("info", "session.connected", "Device session connected.");
      return { ok: true };
    case "disconnectLinkLost":
      syncRuntimeIdentityFromApprovedRules();
      setDisconnected("link lost", {
        reconnectAttempt: 0,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
      });
      return { ok: true };
    case "beginReconnectAttempt":
      syncRuntimeIdentityFromApprovedRules();
      runtimeDevice = createRuntimeDevice("reconnecting", {
        gatewayDisconnectReason: null,
        reconnectAttempt: 1,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
        gatewayLastConnectedAt: runtimeDevice?.gatewayLastConnectedAt ?? null,
        gatewayLastDisconnectedAt: runtimeDevice?.gatewayLastDisconnectedAt ?? nowIso(),
      });
      scanState = "scanning";
      scanReason = "approved-reconnect";
      emitRuntimeDevice();
      emitGatewayState();
      return { ok: true };
    case "completeReconnect":
      syncRuntimeIdentityFromApprovedRules();
      setConnected();
      sendDeviceLog("info", "session.reconnected", "Approved reconnect completed.");
      return { ok: true };
    case "exhaustReconnect":
      syncRuntimeIdentityFromApprovedRules();
      runtimeDevice = createRuntimeDevice("disconnected", {
        gatewayDisconnectReason: "Auto-reconnect paused.",
        reconnectAttempt: 20,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: true,
        reconnectAwaitingDecision: true,
        gatewayLastDisconnectedAt: nowIso(),
      });
      scanState = "stopped";
      scanReason = null;
      emitRuntimeDevice();
      emitGatewayState();
      return { ok: true };
    case "adapterOff":
      adapterState = "poweredOff";
      scanState = "stopped";
      scanReason = null;
      syncRuntimeIdentityFromApprovedRules();
      runtimeDevice = createRuntimeDevice("unreachable", {
        gatewayDisconnectReason: "adapter-poweredOff",
        gatewayLastDisconnectedAt: nowIso(),
      });
      emitAdapters();
      emitRuntimeDevice();
      emitGatewayState();
      return { ok: true };
    case "adapterOn":
      adapterState = "poweredOn";
      syncRuntimeIdentityFromApprovedRules();
      runtimeDevice = createRuntimeDevice("disconnected", {
        gatewayDisconnectReason: "adapter-recovered",
        reconnectAttempt: 0,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
        gatewayLastDisconnectedAt: runtimeDevice?.gatewayLastDisconnectedAt ?? nowIso(),
      });
      refreshApprovedReconnectState();
      emitAdapters();
      emitRuntimeDevice();
      emitGatewayState();
      return { ok: true };
    case "lateDiscovery":
      gatewayLastAdvertisementAt = nowIso();
      runtimeDevice = createRuntimeDevice("discovered", {
        gatewayDisconnectReason: null,
        reconnectAttempt: 0,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
      });
      emitRuntimeDevice();
      emitGatewayState();
      return { ok: true };
    case "telemetryWhileDisconnected":
      syncRuntimeIdentityFromApprovedRules();
      setDisconnected(runtimeDevice?.gatewayDisconnectReason ?? "link lost", {
        reconnectAttempt: runtimeDevice?.reconnectAttempt ?? 0,
        reconnectAttemptLimit: runtimeDevice?.reconnectAttemptLimit ?? 20,
        reconnectRetryExhausted: runtimeDevice?.reconnectRetryExhausted ?? false,
        reconnectAwaitingDecision: runtimeDevice?.reconnectAwaitingDecision ?? false,
      });
      sendPersistMotion("moving", 12);
      sendDeviceLog("info", "motion.telemetry", "Motion telemetry arrived while transport stayed disconnected.");
      return { ok: true };
    case "emitMovingTelemetry":
      syncRuntimeIdentityFromApprovedRules();
      setConnected();
      sendPersistMotion("moving", 12);
      return { ok: true };
    case "emitStillTelemetry":
      syncRuntimeIdentityFromApprovedRules();
      setConnected();
      sendPersistMotion("still", 0);
      return { ok: true };
    default:
      throw new Error(`Unsupported E2E step: ${name}`);
  }
}

function handleCommand(command) {
  try {
    log("command", String(command?.type ?? "unknown"));
    switch (command?.type) {
      case "set_allowed_nodes":
        approvedRules = Array.isArray(command.nodes) ? clone(command.nodes) : [];
        syncRuntimeIdentityFromApprovedRules();
        refreshApprovedReconnectState();
        emitGatewayState();
        respond(command, true, { nodeCount: approvedRules.length });
        return;
      case "start_manual_scan":
        showCandidate();
        return;
      case "pair_manual_candidate":
        if (command.candidateId !== currentCandidate().id) {
          throw new Error("Unknown manual scan candidate.");
        }
        manualScan = {
          state: "pairing",
          pairingCandidateId: command.candidateId,
          error: null,
          candidates: [currentCandidate()],
        };
        emitManualScan();
        syncRuntimeIdentityFromApprovedRules();
        clearManualScan();
        setConnected();
        sendDeviceLog("info", "pairing.connected", "Pairing completed and device connected.");
        respond(command, true, { candidateId: command.candidateId });
        return;
      case "recover_approved_node":
      case "resume_approved_node_reconnect":
        syncRuntimeIdentityFromApprovedRules();
        runtimeDevice = createRuntimeDevice("disconnected", {
          gatewayDisconnectReason: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: false,
          reconnectAwaitingDecision: false,
          gatewayLastDisconnectedAt: runtimeDevice?.gatewayLastDisconnectedAt ?? nowIso(),
        });
        refreshApprovedReconnectState();
        emitRuntimeDevice();
        emitGatewayState();
        respond(command, true, { ruleId: command.ruleId ?? null });
        return;
      case "e2e_step":
        log("step", String(command.name ?? "unknown"));
        respond(command, true, applyStep(command.name));
        return;
      default:
        respond(command, false, `Unsupported control command: ${String(command?.type ?? "unknown")}`);
    }
  } catch (error) {
    respond(command, false, error instanceof Error ? error.message : String(error));
  }
}

process.on("message", (message) => {
  handleCommand(message);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

process.on("SIGINT", () => {
  process.exit(0);
});

function emitInitialState() {
  sendRuntime({
    type: "runtime-ready",
    gateway: currentGateway(),
    issue: null,
    adapters: [
      {
        id: "winrt:0",
        label: "Bluetooth",
        transport: "winrt",
        runtimeDeviceId: null,
        isAvailable: true,
        issue: null,
        details: ["state:PoweredOn"],
      },
    ],
    manualScan: clone(manualScan),
  });

  if (approvedRules.length > 0) {
    emitRuntimeDevice();
    emitGatewayState();
  }
}

setTimeout(emitInitialState, 10);
setTimeout(emitInitialState, 100);
