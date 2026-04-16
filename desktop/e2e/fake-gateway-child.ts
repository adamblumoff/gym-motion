import process from "node:process";

import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  DeviceLogLevel,
  GatewayConnectionState,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  HealthStatus,
  ManualScanCandidateSummary,
  ManualScanState,
  MotionState,
  TelemetryFreshness,
} from "@core/contracts";
import {
  parseGatewayControlCommand,
  type GatewayControlCommand,
} from "../main/managed-gateway-runtime/gateway-child-ipc.js";
import { sendToDesktop } from "../scripts/windows-winrt-gateway-desktop-ipc.js";
import type { GatewayDesktopMessage } from "../scripts/windows-winrt-gateway-types.js";

type FakeNodeIdentity = {
  ruleId: string;
  candidateId: string;
  deviceId: string;
  label: string;
  localName: string;
  address: string;
  peripheralId: string;
  bootId: string;
  firmwareVersion: string;
  hardwareId: string;
  rssi: number;
  machineLabel: string;
  siteId: string;
};

type FakeManualScanPayload = {
  state: ManualScanState;
  pairingCandidateId: string | null;
  error: string | null;
  candidates: ManualScanCandidateSummary[];
};

type GatewayIncomingControlCommand =
  | (GatewayControlCommand & { commandId?: string })
  | {
      type?: string;
      commandId?: string;
      candidateId?: string;
      ruleId?: string;
      name?: string;
      nodes?: unknown;
    };

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
} satisfies FakeNodeIdentity;

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function clone<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function log(...parts: unknown[]) {
  process.stdout.write(`[fake-gateway-child] ${parts.map(String).join(" ")}\n`);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isApprovedNodeRule(input: unknown): input is ApprovedNodeRule {
  return (
    isRecord(input) &&
    typeof input.id === "string" &&
    typeof input.label === "string"
  );
}

function parseApprovedRules(): ApprovedNodeRule[] {
  const raw = process.env.GATEWAY_APPROVED_NODE_RULES;
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isApprovedNodeRule) : [];
  } catch (error) {
    log(
      "failed to parse GATEWAY_APPROVED_NODE_RULES:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

function healthStatusFor(connectionState: GatewayConnectionState): HealthStatus {
  switch (connectionState) {
    case "connected":
      return "online";
    case "connecting":
    case "reconnecting":
    case "discovered":
      return "stale";
    case "disconnected":
    case "unreachable":
    default:
      return "offline";
  }
}

function telemetryFreshnessFor(
  connectionState: GatewayConnectionState,
  lastTelemetryAt: string | null,
): TelemetryFreshness {
  if (connectionState === "connected" && lastTelemetryAt) {
    return "fresh";
  }

  if (lastTelemetryAt) {
    return "stale";
  }

  return "missing";
}

function createAdapterSummary(): BleAdapterSummary {
  return {
    id: "winrt:0",
    label: "Bluetooth",
    transport: "winrt",
    runtimeDeviceId: null,
    isAvailable: adapterState === "poweredOn",
    issue: adapterState === "poweredOn" ? null : `adapter-${adapterState}`,
    details: [`state:${adapterState}`],
  };
}

function normalizeIncomingCommand(input: unknown): GatewayIncomingControlCommand {
  const parsed = parseGatewayControlCommand(input);
  const commandId =
    isRecord(input) && typeof input.commandId === "string" ? input.commandId : undefined;

  if (parsed) {
    return commandId ? { ...parsed, commandId } : parsed;
  }

  if (!isRecord(input)) {
    return {};
  }

  return {
    type: typeof input.type === "string" ? input.type : undefined,
    commandId,
    candidateId:
      typeof input.candidateId === "string" ? input.candidateId : undefined,
    ruleId: typeof input.ruleId === "string" ? input.ruleId : undefined,
    name: typeof input.name === "string" ? input.name : undefined,
    nodes: input.nodes,
  };
}

let approvedRules: ApprovedNodeRule[] = parseApprovedRules();
let adapterState: GatewayStatusSummary["adapterState"] = "poweredOn";
let scanState: GatewayStatusSummary["scanState"] =
  approvedRules.length > 0 ? "scanning" : "stopped";
let scanReason: GatewayStatusSummary["scanReason"] =
  approvedRules.length > 0 ? "approved-reconnect" : null;
let gatewayStartedAt = nowIso();
let gatewayLastAdvertisementAt: string | null = null;
let manualScan: FakeManualScanPayload = {
  state: "idle",
  pairingCandidateId: null,
  error: null,
  candidates: [],
};
let runtimeDevice: GatewayRuntimeDeviceSummary | null =
  approvedRules.length > 0 ? createRuntimeDevice("disconnected") : null;
let motionSequence = 0;
let logSequence = 0;

function currentIdentity(): FakeNodeIdentity {
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

function currentCandidate(): ManualScanCandidateSummary {
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

function createRuntimeDevice(
  connectionState: GatewayConnectionState,
  overrides: Partial<GatewayRuntimeDeviceSummary> = {},
): GatewayRuntimeDeviceSummary {
  const identity = currentIdentity();
  const timestamp = nowIso();
  const gatewayLastTelemetryAt =
    overrides.gatewayLastTelemetryAt ?? runtimeDevice?.gatewayLastTelemetryAt ?? null;

  return {
    id: identity.deviceId,
    lastState: overrides.lastState ?? runtimeDevice?.lastState ?? "still",
    lastSeenAt: overrides.lastSeenAt ?? runtimeDevice?.lastSeenAt ?? nowMs(),
    lastDelta: overrides.lastDelta ?? runtimeDevice?.lastDelta ?? null,
    updatedAt: timestamp,
    hardwareId: identity.hardwareId,
    bootId: identity.bootId,
    firmwareVersion: identity.firmwareVersion,
    machineLabel: identity.machineLabel,
    siteId: identity.siteId,
    provisioningState:
      overrides.provisioningState ?? runtimeDevice?.provisioningState ?? "assigned",
    updateStatus: overrides.updateStatus ?? runtimeDevice?.updateStatus ?? "idle",
    updateTargetVersion:
      overrides.updateTargetVersion ?? runtimeDevice?.updateTargetVersion ?? null,
    updateDetail: overrides.updateDetail ?? runtimeDevice?.updateDetail ?? null,
    updateUpdatedAt:
      overrides.updateUpdatedAt ?? runtimeDevice?.updateUpdatedAt ?? null,
    lastHeartbeatAt:
      overrides.lastHeartbeatAt ?? runtimeDevice?.lastHeartbeatAt ?? null,
    lastEventReceivedAt:
      overrides.lastEventReceivedAt ?? runtimeDevice?.lastEventReceivedAt ?? null,
    healthStatus:
      overrides.healthStatus ?? healthStatusFor(connectionState),
    gatewayConnectionState: connectionState,
    telemetryFreshness:
      overrides.telemetryFreshness ??
      telemetryFreshnessFor(connectionState, gatewayLastTelemetryAt),
    sensorIssue: overrides.sensorIssue ?? runtimeDevice?.sensorIssue ?? null,
    peripheralId: identity.peripheralId,
    address: identity.address,
    gatewayLastAdvertisementAt:
      overrides.gatewayLastAdvertisementAt ?? gatewayLastAdvertisementAt,
    gatewayLastConnectedAt:
      overrides.gatewayLastConnectedAt ??
      (connectionState === "connected"
        ? timestamp
        : runtimeDevice?.gatewayLastConnectedAt ?? null),
    gatewayLastDisconnectedAt:
      connectionState === "connected"
        ? null
        : overrides.gatewayLastDisconnectedAt ?? timestamp,
    gatewayLastTelemetryAt,
    gatewayDisconnectReason:
      overrides.gatewayDisconnectReason ??
      (connectionState === "connected" ? null : "link lost"),
    advertisedName: identity.localName,
    lastRssi: identity.rssi,
    otaStatus: overrides.otaStatus ?? "idle",
    otaTargetVersion: overrides.otaTargetVersion ?? null,
    otaProgressBytesSent: overrides.otaProgressBytesSent ?? null,
    otaTotalBytes: overrides.otaTotalBytes ?? null,
    otaLastPhase: overrides.otaLastPhase ?? null,
    otaFailureDetail: overrides.otaFailureDetail ?? null,
    otaLastStatusMessage: overrides.otaLastStatusMessage ?? null,
    otaUpdatedAt: overrides.otaUpdatedAt ?? null,
    reconnectAttempt: overrides.reconnectAttempt ?? 0,
    reconnectAttemptLimit: overrides.reconnectAttemptLimit ?? 20,
    reconnectRetryExhausted: overrides.reconnectRetryExhausted ?? false,
    reconnectAwaitingDecision: overrides.reconnectAwaitingDecision ?? false,
  };
}

function currentGateway(): GatewayStatusSummary {
  return {
    hostname: "e2e-desktop",
    mode: "reference-ble-node-gateway",
    sessionId: "e2e-session",
    adapterState,
    scanState,
    scanReason,
    connectedNodeCount: runtimeDevice?.gatewayConnectionState === "connected" ? 1 : 0,
    reconnectingNodeCount:
      runtimeDevice?.gatewayConnectionState === "reconnecting" ? 1 : 0,
    knownNodeCount: approvedRules.length,
    startedAt: gatewayStartedAt,
    updatedAt: nowIso(),
    lastAdvertisementAt: gatewayLastAdvertisementAt,
  };
}

function sendRuntime(message: GatewayDesktopMessage) {
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
    adapters: [createAdapterSummary()],
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

function respond(
  command: GatewayIncomingControlCommand,
  ok: boolean,
  resultOrError: unknown,
) {
  if (typeof command.commandId !== "string") {
    return;
  }

  sendRuntime({
    type: "control-response",
    commandId: command.commandId,
    ok,
    ...(ok
      ? { result: resultOrError }
      : { error: String(resultOrError ?? "Unknown error") }),
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
    id: identity.deviceId,
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

function setDisconnected(
  reason = "link lost",
  overrides: Partial<GatewayRuntimeDeviceSummary> = {},
) {
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
    lastEventReceivedAt: nowIso(),
    healthStatus: "online",
    telemetryFreshness: runtimeDevice?.gatewayLastTelemetryAt ? "fresh" : "missing",
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

function sendPersistMotion(state: MotionState, delta: number | null = null) {
  motionSequence += 1;
  const identity = currentIdentity();
  const timestamp = nowMs();
  runtimeDevice = {
    ...(runtimeDevice ?? createRuntimeDevice("disconnected")),
    lastState: state,
    lastSeenAt: timestamp,
    lastDelta: delta,
    gatewayLastTelemetryAt: nowIso(),
    lastEventReceivedAt: nowIso(),
    telemetryFreshness: "fresh",
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

function sendDeviceLog(level: DeviceLogLevel, code: string, message: string) {
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

function applyStep(name: string | undefined) {
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
      sendDeviceLog(
        "info",
        "motion.telemetry",
        "Motion telemetry arrived while transport stayed disconnected.",
      );
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

function handleCommand(command: GatewayIncomingControlCommand) {
  try {
    log("command", String(command.type ?? "unknown"));
    switch (command.type) {
      case "set_allowed_nodes":
        approvedRules =
          Array.isArray(command.nodes) && command.nodes.every(isApprovedNodeRule)
            ? clone(command.nodes)
            : [];
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
        respond(
          command,
          false,
          `Unsupported control command: ${String(command.type ?? "unknown")}`,
        );
    }
  } catch (error) {
    respond(command, false, error instanceof Error ? error.message : String(error));
  }
}

process.on("message", (message: unknown) => {
  handleCommand(normalizeIncomingCommand(message));
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
    adapters: [createAdapterSummary()],
    manualScan: clone(manualScan),
  });

  if (approvedRules.length > 0) {
    emitRuntimeDevice();
    emitGatewayState();
  }
}

setTimeout(emitInitialState, 10);
setTimeout(emitInitialState, 100);
