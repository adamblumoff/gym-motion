/* global Buffer, console, fetch, setTimeout */

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { createGatewayRuntimeServer } from "../../backend/runtime/gateway-runtime-server.mjs";
import { shouldWriteDiscoveryLog } from "./windows-winrt-gateway-logging.mjs";

const config = {
  apiBaseUrl: (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  runtimeHost: process.env.GATEWAY_RUNTIME_HOST ?? "127.0.0.1",
  runtimePort: Number(process.env.GATEWAY_RUNTIME_PORT ?? 4010),
  heartbeatMinIntervalMs: Number(process.env.GATEWAY_HEARTBEAT_DEDUPE_MS ?? 10_000),
  startScanOnBoot: process.env.GATEWAY_START_SCAN_ON_BOOT === "1",
  sidecarPath:
    process.env.GATEWAY_SIDECAR_PATH ??
    path.join(
      process.cwd(),
      "native",
      "windows-ble-sidecar",
      "target",
      "release",
      "gym-motion-ble-winrt.exe",
    ),
  verbose: process.env.GATEWAY_VERBOSE === "1",
};

let approvedNodeRules = parseApprovedNodeRules(process.env.GATEWAY_APPROVED_NODE_RULES);
let selectedAdapterId =
  typeof process.env.GATEWAY_SELECTED_ADAPTER_ID === "string" &&
    process.env.GATEWAY_SELECTED_ADAPTER_ID.length > 0
    ? process.env.GATEWAY_SELECTED_ADAPTER_ID
    : null;

const runtimeServer = createGatewayRuntimeServer({
  apiBaseUrl: config.apiBaseUrl,
  runtimeHost: config.runtimeHost,
  runtimePort: config.runtimePort,
  verbose: config.verbose,
});

const deviceContexts = new Map();
const pendingNodeLogs = new Map();
let sidecar = null;
let shuttingDown = false;
let latestGatewayIssue = null;
let sidecarSessionStarted = false;
let scanRequestedFromBoot = config.startScanOnBoot;
let currentScanReason = null;

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

function parseApprovedNodeRules(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function describeNode(node = {}) {
  return {
    deviceId: node.knownDeviceId ?? node.known_device_id ?? null,
    knownDeviceId: node.knownDeviceId ?? node.known_device_id ?? null,
    peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
    address: node.address ?? null,
    localName: node.localName ?? node.local_name ?? null,
    rssi: node.lastRssi ?? node.last_rssi ?? node.rssi ?? null,
  };
}

function setRuntimeIssue(issue) {
  latestGatewayIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
  runtimeServer.setGatewayIssue(latestGatewayIssue);
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

function selectPreferredAdapter(adapters) {
  return adapters.find((adapter) => adapter.isAvailable)?.id ?? adapters[0]?.id ?? null;
}

function createDeviceContext(deviceId) {
  return {
    deviceId,
    lastState: null,
    lastHeartbeatForwardedAt: 0,
    firmwareVersion: "unknown",
    bootId: null,
    hardwareId: null,
    peripheralId: null,
    address: null,
    advertisedName: null,
    rssi: null,
    lastTelemetryConnectionState: null,
  };
}

async function postJson(targetPath, body) {
  const response = await fetch(`${config.apiBaseUrl}${targetPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${targetPath} -> ${response.status}: ${text}`);
  }

  return await response.json();
}

async function writeDeviceLog({
  deviceId,
  level = "info",
  code,
  message,
  bootId,
  firmwareVersion,
  hardwareId,
  metadata,
}) {
  try {
    await postJson("/api/device-logs", {
      deviceId,
      level,
      code,
      message,
      bootId,
      firmwareVersion,
      hardwareId,
      metadata,
    });
  } catch (error) {
    debug(
      `failed to write gateway log ${code}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function queueNodeLog(peripheralInfo, entry) {
  const key = peripheralInfo.peripheralId ?? peripheralInfo.localName ?? "unknown";
  const knownDeviceId = runtimeServer.resolveKnownDeviceId(peripheralInfo);

  if (knownDeviceId) {
    void writeDeviceLog({
      deviceId: knownDeviceId,
      ...entry,
    });
    return;
  }

  const pendingEntries = pendingNodeLogs.get(key) ?? [];
  pendingEntries.push({
    ...entry,
    peripheralInfo,
  });
  pendingNodeLogs.set(key, pendingEntries);
}

function flushNodeLogs(deviceId, peripheralInfo, devicePayload) {
  const key = peripheralInfo.peripheralId ?? peripheralInfo.localName ?? "unknown";
  const pendingEntries = pendingNodeLogs.get(key);

  if (!pendingEntries?.length) {
    return;
  }

  pendingNodeLogs.delete(key);

  for (const entry of pendingEntries) {
    void writeDeviceLog({
      deviceId,
      level: entry.level,
      code: entry.code,
      message: entry.message,
      bootId: devicePayload?.bootId ?? null,
      firmwareVersion: devicePayload?.firmwareVersion ?? null,
      hardwareId: devicePayload?.hardwareId ?? null,
      metadata: entry.metadata,
    });
  }
}

async function forwardTelemetry(payload, node = {}) {
  let context = deviceContexts.get(payload.deviceId);

  if (!context) {
    context = createDeviceContext(payload.deviceId);
    deviceContexts.set(payload.deviceId, context);
  }

  context.firmwareVersion = payload.firmwareVersion ?? context.firmwareVersion;
  context.bootId = payload.bootId ?? context.bootId ?? null;
  context.hardwareId = payload.hardwareId ?? context.hardwareId ?? null;
  context.peripheralId = node.peripheralId ?? context.peripheralId ?? null;
  context.address = node.address ?? context.address ?? null;
  context.advertisedName = node.localName ?? context.advertisedName ?? null;
  context.rssi = node.lastRssi ?? node.rssi ?? context.rssi ?? null;

  const peripheralInfo = {
    ...describeNode(node),
    deviceId: payload.deviceId,
    knownDeviceId: payload.deviceId,
  };

  flushNodeLogs(payload.deviceId, peripheralInfo, payload);

  const connectionBeforeTelemetry = runtimeServer.inspectNodeConnection({
    deviceId: payload.deviceId,
    knownDeviceId: payload.deviceId,
    peripheralId: peripheralInfo.peripheralId,
    localName: peripheralInfo.localName,
    address: peripheralInfo.address,
  });

  if (connectionBeforeTelemetry?.gatewayConnectionState !== "connected") {
    const transition = runtimeServer.noteConnected(peripheralInfo);

    if (
      transition?.before?.gatewayConnectionState &&
      transition.before.gatewayConnectionState !== "connected"
    ) {
      void writeDeviceLog({
        deviceId: payload.deviceId,
        level: "info",
        code: "node.transport_reasserted_by_telemetry",
        message: "Live BLE telemetry reasserted the Windows transport connection.",
        bootId: payload.bootId ?? null,
        firmwareVersion: payload.firmwareVersion ?? null,
        hardwareId: payload.hardwareId ?? null,
        metadata: {
          peripheralId: peripheralInfo.peripheralId,
          address: peripheralInfo.address,
          transportStateBefore: transition.before.gatewayConnectionState,
          transportStateAfter: transition.after?.gatewayConnectionState ?? "connected",
        },
      });
    }
  }

  const telemetryResult = await runtimeServer.noteTelemetry(payload, peripheralInfo);
  const connectionStateBeforeTelemetry = telemetryResult?.before?.gatewayConnectionState ?? null;

  if (
    connectionStateBeforeTelemetry &&
    connectionStateBeforeTelemetry !== "connected" &&
    context.lastTelemetryConnectionState !== connectionStateBeforeTelemetry
  ) {
    void writeDeviceLog({
      deviceId: payload.deviceId,
      level: "warn",
      code: "node.telemetry_without_transport",
      message: `Telemetry arrived while transport state was ${connectionStateBeforeTelemetry}.`,
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? null,
      hardwareId: payload.hardwareId ?? null,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
        address: node.address ?? null,
        transportStateBefore: connectionStateBeforeTelemetry,
        transportStateAfter: telemetryResult?.after?.gatewayConnectionState ?? null,
        telemetryFreshnessAfter: telemetryResult?.after?.telemetryFreshness ?? null,
        lastTelemetryAt: telemetryResult?.after?.lastTelemetryAt ?? null,
        lastConnectedAt: telemetryResult?.after?.lastConnectedAt ?? null,
        lastDisconnectedAt: telemetryResult?.after?.lastDisconnectedAt ?? null,
      },
    });
  }
  context.lastTelemetryConnectionState = connectionStateBeforeTelemetry;

  const stateChanged = context.lastState !== payload.state;

  if (stateChanged) {
    await postJson("/api/ingest", {
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
    context.lastHeartbeatForwardedAt = Date.now();
    return;
  }

  if (Date.now() - context.lastHeartbeatForwardedAt < config.heartbeatMinIntervalMs) {
    return;
  }

  await postJson("/api/heartbeat", {
    deviceId: payload.deviceId,
    timestamp: payload.timestamp,
    bootId: payload.bootId,
    firmwareVersion: payload.firmwareVersion,
    hardwareId: payload.hardwareId,
  });
  context.lastHeartbeatForwardedAt = Date.now();
}

function handleNodeDiscovered(node, scanReason = null) {
  const peripheralInfo = describeNode(node);

  runtimeServer.noteDiscovery({
    ...peripheralInfo,
    reconnectAttempt: node.reconnect?.attempt ?? null,
    reconnectAttemptLimit: node.reconnect?.attempt_limit ?? null,
    reconnectRetryExhausted: node.reconnect?.retry_exhausted ?? null,
  });

  if (!shouldWriteDiscoveryLog(scanReason)) {
    return;
  }

  queueNodeLog(peripheralInfo, {
    code: "node.discovered",
    message: `Gateway discovered ${node.localName ?? node.local_name ?? node.peripheralId ?? node.peripheral_id ?? "a BLE node"}.`,
    metadata: {
      peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
      address: node.address ?? null,
      advertisedName: node.localName ?? node.local_name ?? null,
      rssi: node.lastRssi ?? node.last_rssi ?? node.rssi ?? null,
    },
  });
}

function handleNodeConnectionState(event) {
  const node = event.node ?? {};
  const peripheralInfo = describeNode(node);
  const label =
    node.localName ?? node.local_name ?? node.peripheralId ?? node.peripheral_id ?? "a BLE node";
  const connectionState =
    event.gatewayConnectionState ?? event.gateway_connection_state ?? "disconnected";

  if (connectionState === "connecting") {
    const transition = runtimeServer.noteConnecting({
      ...peripheralInfo,
      reconnectAttempt: event.reconnect?.attempt ?? null,
      reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
      reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
    });
    queueNodeLog(peripheralInfo, {
      code: "node.connecting",
      message: `Gateway is connecting to ${label}.`,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
        address: node.address ?? null,
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
        transportStateBefore: transition?.before?.gatewayConnectionState ?? null,
        transportStateAfter: transition?.after?.gatewayConnectionState ?? "connecting",
        lastTelemetryAt: transition?.after?.lastTelemetryAt ?? null,
        lastConnectedAt: transition?.after?.lastConnectedAt ?? null,
        lastDisconnectedAt: transition?.after?.lastDisconnectedAt ?? null,
      },
    });
    return;
  }

  if (connectionState === "connected") {
    const transition = runtimeServer.noteConnected({
      ...peripheralInfo,
      reconnectAttempt: event.reconnect?.attempt ?? null,
      reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
    });
    queueNodeLog(peripheralInfo, {
      code: "node.connected",
      message: `Gateway connected to ${label}.`,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
        address: node.address ?? null,
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        transportStateBefore: transition?.before?.gatewayConnectionState ?? null,
        transportStateAfter: transition?.after?.gatewayConnectionState ?? "connected",
        lastTelemetryAt: transition?.after?.lastTelemetryAt ?? null,
        lastConnectedAt: transition?.after?.lastConnectedAt ?? null,
        lastDisconnectedAt: transition?.after?.lastDisconnectedAt ?? null,
      },
    });
    return;
  }

  const transition = runtimeServer.noteDisconnected({
    ...peripheralInfo,
    reason: event.reason ?? "ble-disconnected",
    reconnectAttempt: event.reconnect?.attempt ?? null,
    reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
    reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
  });
  if (!transition?.applied) {
    queueNodeLog(peripheralInfo, {
      level: "warn",
      code: "node.disconnect_ignored",
      message: `Gateway ignored a transient disconnect signal for ${label}.`,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
        address: node.address ?? null,
        reason: event.reason ?? "ble-disconnected",
        reconnectAttempt: event.reconnect?.attempt ?? null,
        reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
        reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
        transportStateBefore: transition?.before?.gatewayConnectionState ?? null,
        transportStateAfter: transition?.after?.gatewayConnectionState ?? null,
        lastTelemetryAt: transition?.before?.lastTelemetryAt ?? null,
        lastConnectedAt: transition?.before?.lastConnectedAt ?? null,
        lastDisconnectedAt: transition?.before?.lastDisconnectedAt ?? null,
      },
    });
    return;
  }

  if (transition.before?.gatewayConnectionState === "disconnected") {
    return;
  }

  queueNodeLog(peripheralInfo, {
    level: "warn",
    code: "node.disconnected",
    message: `Gateway lost ${label}.`,
    metadata: {
      peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
      address: node.address ?? null,
      reason: event.reason ?? "ble-disconnected",
      reconnectAttempt: event.reconnect?.attempt ?? null,
      reconnectAttemptLimit: event.reconnect?.attempt_limit ?? null,
      reconnectRetryExhausted: event.reconnect?.retry_exhausted ?? null,
      transportStateBefore: transition.before?.gatewayConnectionState ?? null,
      transportStateAfter: transition.after?.gatewayConnectionState ?? connectionState,
      lastTelemetryAt: transition.after?.lastTelemetryAt ?? transition.before?.lastTelemetryAt ?? null,
      lastConnectedAt: transition.after?.lastConnectedAt ?? transition.before?.lastConnectedAt ?? null,
      lastDisconnectedAt: transition.after?.lastDisconnectedAt ?? null,
    },
  });
}

function sendCommand(type, payload = {}) {
  if (!sidecar?.stdin || sidecar.killed) {
    return;
  }

  sidecar.stdin.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function sidecarAllowedNodesPayload() {
  return approvedNodeRules.map((node) => ({
    id: node.id,
    label: node.label,
    peripheral_id: node.peripheralId ?? null,
    address: node.address ?? null,
    local_name: node.localName ?? null,
    known_device_id: node.knownDeviceId ?? null,
  }));
}

function syncAllowedNodes() {
  sendCommand("set_allowed_nodes", {
    nodes: sidecarAllowedNodesPayload(),
  });
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

    try {
      const command = JSON.parse(trimmed);

      if (command.type === "set_allowed_nodes" && Array.isArray(command.nodes)) {
        approvedNodeRules = command.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
          address: node.address ?? null,
          localName: node.localName ?? node.local_name ?? null,
          knownDeviceId: node.knownDeviceId ?? node.known_device_id ?? null,
        }));
        syncAllowedNodes();
        return;
      }

      if (command.type === "rescan") {
        sendCommand("rescan");
        return;
      }

      if (command.type === "request_silent_reconnect") {
        sendCommand("refresh_scan_policy");
        return;
      }

      if (command.type === "recover_approved_node" && typeof command.ruleId === "string") {
        sendCommand("recover_approved_node", {
          rule_id: command.ruleId,
        });
      }
    } catch (error) {
      console.error("[gateway-winrt] failed to parse control command", error);
    }
  });
}

function handleSidecarEvent(event) {
  switch (event.type) {
    case "ready":
      log("Windows BLE sidecar is ready.");
      break;
    case "adapter_list":
      {
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
        log(
          `received ${adapters.length} adapter${adapters.length === 1 ? "" : "s"} from sidecar`,
          adapters,
        );
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
      }
      break;
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
    case "node_discovered":
      handleNodeDiscovered(
        event.node ?? {},
        event.scan_reason ?? event.scanReason ?? null,
      );
      break;
    case "node_connection_state":
      handleNodeConnectionState(event);
      break;
    case "telemetry":
      {
        const payload = {
          deviceId: event.payload?.device_id ?? event.payload?.deviceId,
          state: event.payload?.state,
          timestamp: event.payload?.timestamp,
          delta: event.payload?.delta ?? null,
          sequence: event.payload?.sequence,
          bootId: event.payload?.boot_id ?? event.payload?.bootId,
          firmwareVersion:
            event.payload?.firmware_version ?? event.payload?.firmwareVersion,
          hardwareId: event.payload?.hardware_id ?? event.payload?.hardwareId,
        };

        if (!payload.deviceId || !payload.state || !payload.timestamp) {
          setRuntimeIssue("Windows BLE sidecar emitted an invalid telemetry payload.");
          break;
        }

        void forwardTelemetry(payload, event.node ?? {}).catch((error) => {
        console.error("[gateway-winrt] failed to forward telemetry", error);
        setRuntimeIssue(error instanceof Error ? error.message : "Telemetry forwarding failed.");
        });
      }
      break;
    case "log":
      log(event.message ?? "sidecar log", event.details);
      break;
    case "error":
      setRuntimeIssue(event.message ?? "Windows BLE sidecar failed.");
      console.error("[gateway-winrt] sidecar error", event);
      break;
    default:
      debug("ignored sidecar event", event);
  }
}

function attachJsonLineReader(stream, onEvent) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += Buffer.from(chunk).toString("utf8");

    while (true) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        onEvent(JSON.parse(line));
      } catch (error) {
        console.error("[gateway-winrt] failed to parse sidecar output", line, error);
      }
    }
  });
}

async function startSidecar() {
  sidecarSessionStarted = false;
  scanRequestedFromBoot = config.startScanOnBoot;
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

void runtimeServer.start()
  .then(async () => {
    runtimeServer.setGatewayIssue("Starting Windows BLE runtime…");
    await startSidecar();
  })
  .catch((error) => {
    console.error("[gateway-winrt] failed to start Windows runtime", error);
    process.exitCode = 1;
  });
