/* global Buffer, console, fetch */

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { createGatewayRuntimeServer } from "../../legacy/scripts/gateway-runtime-server.mjs";

const config = {
  apiBaseUrl: (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  runtimeHost: process.env.GATEWAY_RUNTIME_HOST ?? "127.0.0.1",
  runtimePort: Number(process.env.GATEWAY_RUNTIME_PORT ?? 4010),
  heartbeatMinIntervalMs: Number(process.env.GATEWAY_HEARTBEAT_DEDUPE_MS ?? 10_000),
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

const approvedNodeRules = parseApprovedNodeRules(process.env.GATEWAY_APPROVED_NODE_RULES);
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

  flushNodeLogs(payload.deviceId, describeNode(node), payload);

  await runtimeServer.noteTelemetry(payload, describeNode(node));

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

function handleNodeDiscovered(node) {
  const peripheralInfo = describeNode(node);

  runtimeServer.noteDiscovery(peripheralInfo);
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
    runtimeServer.noteConnecting(peripheralInfo);
    queueNodeLog(peripheralInfo, {
      code: "node.connecting",
      message: `Gateway is connecting to ${label}.`,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
      },
    });
    return;
  }

  if (connectionState === "connected") {
    runtimeServer.noteConnected(peripheralInfo);
    queueNodeLog(peripheralInfo, {
      code: "node.connected",
      message: `Gateway connected to ${label}.`,
      metadata: {
        peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
      },
    });
    return;
  }

  runtimeServer.noteDisconnected({
    ...peripheralInfo,
    reason: event.reason ?? "ble-disconnected",
  });
  queueNodeLog(peripheralInfo, {
    level: connectionState === "reconnecting" ? "warn" : "info",
    code: "node.disconnected",
    message: `Gateway lost ${label}.`,
    metadata: {
      peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
      reason: event.reason ?? "ble-disconnected",
    },
  });
}

function sendCommand(type, payload = {}) {
  if (!sidecar?.stdin || sidecar.killed) {
    return;
  }

  sidecar.stdin.write(`${JSON.stringify({ type, ...payload })}\n`);
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
      }
      break;
    case "gateway_state":
      runtimeServer.setAdapterState(
        event.gateway?.adapter_state ?? event.adapterState ?? "unknown",
      );
      runtimeServer.setScanState(event.gateway?.scan_state ?? event.scanState ?? "stopped");
      setRuntimeIssue(event.gateway?.issue ?? event.issue ?? null);
      break;
    case "node_discovered":
      handleNodeDiscovered(event.node ?? {});
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
    runtimeServer.setAdapterState("unknown");
    runtimeServer.setScanState("stopped");

    if (!shuttingDown) {
      setRuntimeIssue(`Windows BLE sidecar exited (${signal ?? code ?? "unknown"}).`);
    }
  });

  if (selectedAdapterId) {
    sendCommand("select_adapter", { adapter_id: selectedAdapterId });
  }
  sendCommand("set_allowed_nodes", {
    nodes: approvedNodeRules.map((node) => ({
      id: node.id,
      label: node.label,
      peripheral_id: node.peripheralId ?? null,
      address: node.address ?? null,
      local_name: node.localName ?? null,
      known_device_id: node.knownDeviceId ?? null,
    })),
  });
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
    sendCommand("shutdown");
    sidecar.kill("SIGTERM");
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

void runtimeServer.start()
  .then(async () => {
    runtimeServer.setGatewayIssue("Starting Windows BLE runtime…");
    await startSidecar();
  })
  .catch((error) => {
    console.error("[gateway-winrt] failed to start Windows runtime", error);
    process.exitCode = 1;
  });
