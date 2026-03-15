import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const METADATA_REFRESH_MS = 15_000;
const STREAM_PING_MS = 15_000;
const TELEMETRY_FRESH_MS = 20_000;
const DEFAULT_KNOWN_NODE_DIR = path.join(process.cwd(), "data");

function nowIso() {
  return new Date().toISOString();
}

function parseIsoTime(value) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function formatSseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function latestTimestamp(...timestamps) {
  let latestValue = null;
  let latestTime = 0;

  for (const timestamp of timestamps) {
    const parsed = parseIsoTime(timestamp);

    if (parsed > latestTime) {
      latestTime = parsed;
      latestValue = timestamp;
    }
  }

  return latestValue;
}

function telemetryFreshnessFromTimestamp(timestamp) {
  if (!timestamp) {
    return "missing";
  }

  return Date.now() - parseIsoTime(timestamp) <= TELEMETRY_FRESH_MS ? "fresh" : "stale";
}

function healthStatusFromRuntime(connectionState, telemetryFreshness) {
  if (connectionState === "connected" && telemetryFreshness === "fresh") {
    return "online";
  }

  if (
    (connectionState === "connected" && telemetryFreshness !== "fresh") ||
    connectionState === "connecting" ||
    connectionState === "reconnecting" ||
    connectionState === "discovered"
  ) {
    return "stale";
  }

  return "offline";
}

function sortDevices(devices) {
  return devices.toSorted(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

function emptyOtaRuntimeState() {
  return {
    otaStatus: "idle",
    otaTargetVersion: null,
    otaProgressBytesSent: null,
    otaTotalBytes: null,
    otaLastPhase: null,
    otaFailureDetail: null,
    otaLastStatusMessage: null,
    otaUpdatedAt: null,
  }
}

function emptyReconnectRuntimeState() {
  return {
    reconnectAttempt: 0,
    reconnectAttemptLimit: 20,
    reconnectRetryExhausted: false,
  };
}

export function createGatewayRuntimeServer({
  apiBaseUrl,
  runtimeHost,
  runtimePort,
  knownNodesPath = path.join(DEFAULT_KNOWN_NODE_DIR, "gateway-known-nodes.json"),
  verbose = false,
}) {
  const sessionId = crypto.randomUUID();
  const metadataByDeviceId = new Map();
  const runtimeByDeviceId = new Map();
  const knownNodesByDeviceId = new Map();
  const deviceIdByPeripheralId = new Map();
  const discoveriesById = new Map();
  const streamClients = new Set();
  let availableAdapters = [];
  let metadataLoadedAt = 0;
  let knownNodesWriteTimer = null;
  let knownNodesPersistPromise = null;
  let runtimeIssue = null;
  let server = null;

  const gatewayState = {
    hostname: os.hostname(),
    mode: "reference-ble-node-gateway",
    sessionId,
    adapterState: "unknown",
    scanState: "idle",
    scanReason: null,
    connectedNodeCount: 0,
    reconnectingNodeCount: 0,
    knownNodeCount: 0,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    lastAdvertisementAt: null,
  };

  function debug(message, details) {
    if (!verbose) {
      return;
    }

    if (details !== undefined) {
      console.log(`[gateway-runtime] ${message}`, details);
      return;
    }

    console.log(`[gateway-runtime] ${message}`);
  }

  function touchGatewayState(patch = {}) {
    Object.assign(gatewayState, patch, { updatedAt: nowIso() });
    gatewayState.knownNodeCount = knownNodesByDeviceId.size;
    gatewayState.connectedNodeCount = Array.from(runtimeByDeviceId.values()).filter(
      (node) => node.gatewayConnectionState === "connected",
    ).length;
    gatewayState.reconnectingNodeCount = Array.from(runtimeByDeviceId.values()).filter(
      (node) =>
        node.gatewayConnectionState === "reconnecting" ||
        node.gatewayConnectionState === "connecting",
    ).length;
  }

  function broadcast(event, payload) {
    const body = formatSseEvent(event, payload);

    for (const client of streamClients) {
      client.write(body);
    }
  }

  function broadcastGatewayStatus() {
    touchGatewayState();
    broadcast("gateway-status", {
      ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
      gateway: gatewayState,
      error: runtimeIssue ?? undefined,
    });
  }

  async function persistKnownNodes() {
    if (knownNodesPersistPromise) {
      return knownNodesPersistPromise;
    }

    knownNodesPersistPromise = (async () => {
      try {
        await fs.mkdir(path.dirname(knownNodesPath), { recursive: true });
        await fs.writeFile(
          knownNodesPath,
          JSON.stringify(
            {
              updatedAt: nowIso(),
              nodes: Array.from(knownNodesByDeviceId.values()),
            },
            null,
            2,
          ),
          "utf8",
        );
      } catch (error) {
        console.error("[gateway-runtime] failed to persist known-node cache", error);
      } finally {
        knownNodesPersistPromise = null;
      }
    })();

    return knownNodesPersistPromise;
  }

  function scheduleKnownNodesPersist() {
    if (knownNodesWriteTimer) {
      clearTimeout(knownNodesWriteTimer);
    }

    knownNodesWriteTimer = setTimeout(async () => {
      knownNodesWriteTimer = null;
      await persistKnownNodes();
    }, 150);
    knownNodesWriteTimer.unref?.();
  }

  async function loadKnownNodes() {
    try {
      const raw = await fs.readFile(knownNodesPath, "utf8");
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];

      for (const node of nodes) {
        if (!node?.deviceId) {
          continue;
        }

        knownNodesByDeviceId.set(node.deviceId, node);

        if (node.peripheralId) {
          deviceIdByPeripheralId.set(node.peripheralId, node.deviceId);
        }

        runtimeByDeviceId.set(node.deviceId, {
          gatewayConnectionState: "disconnected",
          peripheralId: node.peripheralId ?? null,
          gatewayLastAdvertisementAt: node.lastSeenAt ?? null,
          gatewayLastConnectedAt: node.lastConnectedAt ?? null,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: null,
          gatewayDisconnectReason: null,
          advertisedName: node.lastAdvertisedName ?? null,
          lastRssi: null,
          lastState: "still",
          lastSeenAt: null,
          lastDelta: null,
          firmwareVersion: node.firmwareVersion ?? "unknown",
          bootId: null,
          hardwareId: node.hardwareId ?? null,
          ...emptyOtaRuntimeState(),
          ...emptyReconnectRuntimeState(),
          updatedAt: nowIso(),
        });
      }

      touchGatewayState();
    } catch (error) {
      const code = error?.code;

      if (code !== "ENOENT") {
        console.error("[gateway-runtime] failed to load known-node cache", error);
      }
    }
  }

  async function refreshMetadata(force = false) {
    if (!force && Date.now() - metadataLoadedAt < METADATA_REFRESH_MS) {
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/devices`, {
        headers: {
          "Cache-Control": "no-store",
        },
      });

      if (!response.ok) {
        throw new Error(`/api/devices -> ${response.status}`);
      }

      const payload = await response.json();
      const devices = Array.isArray(payload?.devices) ? payload.devices : [];

      metadataByDeviceId.clear();

      for (const device of devices) {
        if (device?.id) {
          metadataByDeviceId.set(device.id, device);
        }
      }

      metadataLoadedAt = Date.now();
    } catch (error) {
      debug("metadata refresh failed", error instanceof Error ? error.message : String(error));
    }
  }

  function mergeDevice(deviceId) {
    const metadata = metadataByDeviceId.get(deviceId);
    const runtime = runtimeByDeviceId.get(deviceId);
    const known = knownNodesByDeviceId.get(deviceId);
    const connectionState =
      runtime?.gatewayConnectionState ??
      (known ? "disconnected" : "unreachable");
    const freshnessTimestamp = latestTimestamp(
      runtime?.gatewayLastTelemetryAt ?? null,
      metadata?.lastHeartbeatAt ?? null,
      metadata?.lastEventReceivedAt ?? null,
    );
    const telemetryFreshness = telemetryFreshnessFromTimestamp(
      freshnessTimestamp,
    );

    return {
      id: deviceId,
      lastState: runtime?.lastState ?? metadata?.lastState ?? "still",
      lastSeenAt: runtime?.lastSeenAt ?? metadata?.lastSeenAt ?? 0,
      lastDelta: runtime?.lastDelta ?? metadata?.lastDelta ?? null,
      updatedAt: runtime?.updatedAt ?? metadata?.updatedAt ?? nowIso(),
      hardwareId: runtime?.hardwareId ?? metadata?.hardwareId ?? known?.hardwareId ?? null,
      bootId: runtime?.bootId ?? metadata?.bootId ?? null,
      firmwareVersion:
        runtime?.firmwareVersion ?? metadata?.firmwareVersion ?? known?.firmwareVersion ?? "unknown",
      machineLabel: metadata?.machineLabel ?? known?.machineLabel ?? null,
      siteId: metadata?.siteId ?? known?.siteId ?? null,
      provisioningState: metadata?.provisioningState ?? "assigned",
      updateStatus: metadata?.updateStatus ?? "idle",
      lastHeartbeatAt: metadata?.lastHeartbeatAt ?? null,
      lastEventReceivedAt: metadata?.lastEventReceivedAt ?? null,
      updateTargetVersion: metadata?.updateTargetVersion ?? null,
      updateDetail: metadata?.updateDetail ?? null,
      updateUpdatedAt: metadata?.updateUpdatedAt ?? null,
      healthStatus: healthStatusFromRuntime(connectionState, telemetryFreshness),
      gatewayConnectionState: connectionState,
      telemetryFreshness,
      peripheralId: runtime?.peripheralId ?? known?.peripheralId ?? null,
      gatewayLastAdvertisementAt:
        runtime?.gatewayLastAdvertisementAt ?? known?.lastSeenAt ?? null,
      gatewayLastConnectedAt:
        runtime?.gatewayLastConnectedAt ?? known?.lastConnectedAt ?? null,
      gatewayLastDisconnectedAt: runtime?.gatewayLastDisconnectedAt ?? null,
      gatewayLastTelemetryAt: runtime?.gatewayLastTelemetryAt ?? null,
      gatewayDisconnectReason: runtime?.gatewayDisconnectReason ?? null,
      advertisedName: runtime?.advertisedName ?? known?.lastAdvertisedName ?? null,
      lastRssi: runtime?.lastRssi ?? null,
      otaStatus: runtime?.otaStatus ?? metadata?.updateStatus ?? "idle",
      otaTargetVersion: runtime?.otaTargetVersion ?? metadata?.updateTargetVersion ?? null,
      otaProgressBytesSent: runtime?.otaProgressBytesSent ?? null,
      otaTotalBytes: runtime?.otaTotalBytes ?? null,
      otaLastPhase: runtime?.otaLastPhase ?? null,
      otaFailureDetail: runtime?.otaFailureDetail ?? metadata?.updateDetail ?? null,
      otaLastStatusMessage: runtime?.otaLastStatusMessage ?? null,
      otaUpdatedAt: runtime?.otaUpdatedAt ?? metadata?.updateUpdatedAt ?? null,
      reconnectAttempt: runtime?.reconnectAttempt ?? 0,
      reconnectAttemptLimit: runtime?.reconnectAttemptLimit ?? 20,
      reconnectRetryExhausted: runtime?.reconnectRetryExhausted ?? false,
    };
  }

  function emitDevice(deviceId) {
    if (!deviceId) {
      return;
    }

    const device = mergeDevice(deviceId);
    broadcast("gateway-device", { device });
  }

  function upsertKnownNode(deviceId, patch) {
    if (!deviceId) {
      return;
    }

    const previous = knownNodesByDeviceId.get(deviceId) ?? {
      deviceId,
    };
    const next = {
      ...previous,
      ...patch,
      deviceId,
    };

    knownNodesByDeviceId.set(deviceId, next);

    if (next.peripheralId) {
      deviceIdByPeripheralId.set(next.peripheralId, deviceId);
    }

    scheduleKnownNodesPersist();
    touchGatewayState();
  }

  function resolveKnownDeviceId(peripheralId) {
    if (!peripheralId) {
      return null;
    }

    return deviceIdByPeripheralId.get(peripheralId) ?? null;
  }

  function normalizeBleAddress(address) {
    return typeof address === "string" ? address.toLowerCase() : null;
  }

  function resolveKnownDeviceIdByDiscovery({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    localName,
    address,
  }) {
    if (deviceId) {
      return deviceId;
    }

    if (knownDeviceId) {
      return knownDeviceId;
    }

    const directMatch = resolveKnownDeviceId(peripheralId);

    if (directMatch) {
      return directMatch;
    }

    if (localName) {
      const nameMatches = Array.from(knownNodesByDeviceId.values()).filter(
        (node) => node.lastAdvertisedName === localName,
      );

      if (nameMatches.length === 1) {
        return nameMatches[0].deviceId;
      }
    }

    if (address) {
      const normalizedAddress = normalizeBleAddress(address);
      const addressMatches = Array.from(knownNodesByDeviceId.values()).filter(
        (node) => normalizeBleAddress(node.lastKnownAddress) === normalizedAddress,
      );

      if (addressMatches.length === 1) {
        return addressMatches[0].deviceId;
      }
    }

    return null;
  }

  function updateRuntimeNode(deviceId, patch) {
    if (!deviceId) {
      return;
    }

    const previous = runtimeByDeviceId.get(deviceId) ?? {
      gatewayConnectionState: "discovered",
      peripheralId: patch.peripheralId ?? null,
      address: patch.address ?? null,
      gatewayLastAdvertisementAt: null,
      gatewayLastConnectedAt: null,
      gatewayLastDisconnectedAt: null,
      gatewayLastTelemetryAt: null,
      gatewayDisconnectReason: null,
      advertisedName: null,
      lastRssi: null,
      lastState: "still",
      lastSeenAt: 0,
      lastDelta: null,
      firmwareVersion: "unknown",
      bootId: null,
      hardwareId: null,
      ...emptyOtaRuntimeState(),
      ...emptyReconnectRuntimeState(),
      updatedAt: nowIso(),
    };
    const next = {
      ...previous,
      ...patch,
      updatedAt: nowIso(),
    };

    runtimeByDeviceId.set(deviceId, next);
    touchGatewayState();
  }

  function normalizeIdleConnectionStates() {
    for (const [deviceId, runtime] of runtimeByDeviceId.entries()) {
      if (
        runtime.gatewayConnectionState === "connecting" ||
        runtime.gatewayConnectionState === "reconnecting" ||
        runtime.gatewayConnectionState === "discovered"
      ) {
        runtimeByDeviceId.set(deviceId, {
          ...runtime,
          gatewayConnectionState: "disconnected",
          updatedAt: nowIso(),
        });
        emitDevice(deviceId);
      }
    }
  }

  function inspectNodeConnection({
    deviceId = null,
    knownDeviceId = null,
    peripheralId,
    localName,
    address,
  }) {
    const resolvedDeviceId =
      deviceId ??
      resolveKnownDeviceIdByDiscovery({ knownDeviceId, peripheralId, localName, address });

    if (!resolvedDeviceId) {
      return null;
    }

    const runtime = runtimeByDeviceId.get(resolvedDeviceId) ?? null;
    const merged = mergeDevice(resolvedDeviceId);
    return {
      deviceId: resolvedDeviceId,
      gatewayConnectionState: merged.gatewayConnectionState,
      telemetryFreshness: merged.telemetryFreshness,
      lastTelemetryAt: runtime?.gatewayLastTelemetryAt ?? null,
      lastConnectedAt: runtime?.gatewayLastConnectedAt ?? null,
      lastDisconnectedAt: runtime?.gatewayLastDisconnectedAt ?? null,
      disconnectReason: runtime?.gatewayDisconnectReason ?? null,
    };
  }

  function discoveryIdFor({ peripheralId, address, localName, knownDeviceId }) {
    if (knownDeviceId) {
      return `known:${knownDeviceId}`;
    }

    if (peripheralId) {
      return `peripheral:${peripheralId}`;
    }

    if (address) {
      return `address:${address}`;
    }

    if (localName) {
      return `name:${localName}`;
    }

    return "unknown";
  }

  function upsertDiscovery({ peripheralId, address, localName, rssi, knownDeviceId = null }) {
    const id = discoveryIdFor({ peripheralId, address, localName, knownDeviceId });
    const aliasIds = new Set();

    if (knownDeviceId) {
      aliasIds.add(`known:${knownDeviceId}`);
    }

    if (peripheralId) {
      aliasIds.add(`peripheral:${peripheralId}`);
    }

    if (address) {
      aliasIds.add(`address:${address}`);
    }

    if (localName) {
      aliasIds.add(`name:${localName}`);
    }

    let previous = discoveriesById.get(id) ?? {};

    for (const aliasId of aliasIds) {
      if (aliasId === id) {
        continue;
      }

      const aliasEntry = discoveriesById.get(aliasId);

      if (!aliasEntry) {
        continue;
      }

      previous = {
        ...aliasEntry,
        ...previous,
      };
      discoveriesById.delete(aliasId);
    }
    const next = {
      ...previous,
      id,
      peripheralId: peripheralId ?? previous.peripheralId ?? null,
      address: address ?? previous.address ?? null,
      localName: localName ?? previous.localName ?? null,
      knownDeviceId,
      lastSeenAt: nowIso(),
      lastRssi: rssi ?? previous.lastRssi ?? null,
    };

    discoveriesById.set(id, next);
    return next;
  }

  async function getDevicesPayload() {
    await refreshMetadata();

    const deviceIds = new Set([
      ...knownNodesByDeviceId.keys(),
      ...runtimeByDeviceId.keys(),
      ...metadataByDeviceId.keys(),
    ]);

    return {
      ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
      gateway: gatewayState,
      error: runtimeIssue ?? undefined,
      devices: sortDevices(Array.from(deviceIds, mergeDevice)),
    };
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      touchGatewayState();
      jsonResponse(response, 200, {
        ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
        gateway: gatewayState,
        error: runtimeIssue ?? undefined,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      jsonResponse(response, 200, await getDevicesPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/discoveries") {
      jsonResponse(response, 200, {
        discoveries: Array.from(discoveriesById.values()).toSorted(
          (left, right) =>
            new Date(right.lastSeenAt ?? 0).getTime() -
            new Date(left.lastSeenAt ?? 0).getTime(),
        ),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/adapters") {
      jsonResponse(response, 200, {
        adapters: availableAdapters,
        error: runtimeIssue ?? undefined,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/stream") {
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      });

      const ping = setInterval(() => {
        response.write(": ping\n\n");
      }, STREAM_PING_MS);
      ping.unref?.();

      streamClients.add(response);
      response.write(formatSseEvent("connected", { ok: true }));
      response.write(
        formatSseEvent("gateway-status", {
          ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
          gateway: gatewayState,
          error: runtimeIssue ?? undefined,
        }),
      );

      const devicesPayload = await getDevicesPayload();
      for (const device of devicesPayload.devices) {
        response.write(formatSseEvent("gateway-device", { device }));
      }

      request.on("close", () => {
        clearInterval(ping);
        streamClients.delete(response);
        response.end();
      });
      return;
    }

    jsonResponse(response, 404, { ok: false, error: "Not found." });
  }

  return {
    async start() {
      await loadKnownNodes();

      if (server) {
        return;
      }

      server = http.createServer((request, response) => {
        void handleRequest(request, response).catch((error) => {
          console.error("[gateway-runtime] request failed", error);
          jsonResponse(response, 500, { ok: false, error: "Gateway runtime failed." });
        });
      });

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(runtimePort, runtimeHost, () => {
          server?.off("error", reject);
          resolve();
        });
      });

      debug(`runtime API listening on http://${runtimeHost}:${runtimePort}`);
    },

    async stop() {
      if (knownNodesWriteTimer) {
        clearTimeout(knownNodesWriteTimer);
        knownNodesWriteTimer = null;
        await persistKnownNodes();
      }

      for (const client of streamClients) {
        client.end();
      }
      streamClients.clear();

      if (!server) {
        return;
      }

      const currentServer = server;
      server = null;

      await new Promise((resolve, reject) => {
        currentServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },

    setAdapterState(state) {
      touchGatewayState({ adapterState: state });

      if (state === "poweredOn") {
        for (const deviceId of knownNodesByDeviceId.keys()) {
          updateRuntimeNode(deviceId, {
            gatewayConnectionState: "disconnected",
          });
          emitDevice(deviceId);
        }
      } else {
        for (const [deviceId, runtime] of runtimeByDeviceId.entries()) {
          runtimeByDeviceId.set(deviceId, {
            ...runtime,
            gatewayConnectionState: "unreachable",
            gatewayLastDisconnectedAt: nowIso(),
            gatewayDisconnectReason: `adapter-${state}`,
            updatedAt: nowIso(),
          });
          emitDevice(deviceId);
        }
      }

      broadcastGatewayStatus();
    },

    setGatewayIssue(issue) {
      runtimeIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
      broadcastGatewayStatus();
    },

    setAvailableAdapters(adapters) {
      availableAdapters = Array.isArray(adapters) ? adapters : [];
      broadcast("gateway-adapters", { adapters: availableAdapters });
      broadcastGatewayStatus();
    },

    setScanState(scanState, scanReason = null) {
      touchGatewayState({
        scanState,
        scanReason: scanState === "scanning" ? scanReason : null,
      });

      if (scanState !== "scanning") {
        normalizeIdleConnectionStates();
      }

      broadcastGatewayStatus();
    },

    noteDiscovery({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      address,
      localName,
      rssi,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
      reconnectRetryExhausted = null,
    }) {
      const timestamp = nowIso();
      touchGatewayState({ lastAdvertisementAt: timestamp });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      upsertDiscovery({
        peripheralId,
        address,
        localName,
        rssi,
        knownDeviceId: resolvedDeviceId,
      });

      if (!resolvedDeviceId) {
        broadcastGatewayStatus();
        return;
      }

      const existingRuntime = runtimeByDeviceId.get(resolvedDeviceId) ?? null;
      const nextConnectionState =
        existingRuntime?.gatewayConnectionState ??
        (gatewayState.adapterState === "poweredOn" ? "discovered" : "unreachable");

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: nextConnectionState,
        gatewayLastAdvertisementAt: timestamp,
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
        reconnectAttempt:
          reconnectAttempt ?? existingRuntime?.reconnectAttempt ?? 0,
        reconnectAttemptLimit:
          reconnectAttemptLimit ?? existingRuntime?.reconnectAttemptLimit ?? 20,
        reconnectRetryExhausted:
          reconnectRetryExhausted ?? existingRuntime?.reconnectRetryExhausted ?? false,
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();

      upsertKnownNode(resolvedDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
        lastSeenAt: timestamp,
      });
    },

    noteConnecting({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      address,
      localName,
      rssi,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
      reconnectRetryExhausted = null,
    }) {
      const previous = inspectNodeConnection({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      upsertDiscovery({
        peripheralId,
        address,
        localName,
        rssi,
        knownDeviceId: resolvedDeviceId,
      });

      if (!resolvedDeviceId) {
        return;
      }

      const nextConnectionState =
        previous?.gatewayConnectionState === "disconnected" ||
        previous?.gatewayConnectionState === "unreachable"
          ? "reconnecting"
          : "connecting";

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: nextConnectionState,
        gatewayLastAdvertisementAt: nowIso(),
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
        reconnectAttempt,
        reconnectAttemptLimit:
          reconnectAttemptLimit ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttemptLimit ??
          20,
        reconnectRetryExhausted: reconnectRetryExhausted ?? false,
      });
      upsertKnownNode(resolvedDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return {
        before: previous,
        after: inspectNodeConnection({ deviceId: resolvedDeviceId }),
      };
    },

    noteConnected({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      address,
      localName,
      rssi,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
    }) {
      const previous = inspectNodeConnection({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      upsertDiscovery({
        peripheralId,
        address,
        localName,
        rssi,
        knownDeviceId: resolvedDeviceId,
      });

      if (!resolvedDeviceId) {
        return;
      }

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: "connected",
        gatewayLastConnectedAt: nowIso(),
        gatewayDisconnectReason: null,
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
        reconnectAttempt: reconnectAttempt ?? 0,
        reconnectAttemptLimit:
          reconnectAttemptLimit ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttemptLimit ??
          20,
        reconnectRetryExhausted: false,
      });
      upsertKnownNode(resolvedDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
        lastConnectedAt: nowIso(),
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return {
        before: previous,
        after: inspectNodeConnection({ deviceId: resolvedDeviceId }),
      };
    },

    async noteTelemetry(payload, peripheralInfo = {}) {
      const previous = inspectNodeConnection({ deviceId: payload.deviceId });
      const telemetryAt = nowIso();

      updateRuntimeNode(payload.deviceId, {
        peripheralId:
          peripheralInfo.peripheralId ??
          runtimeByDeviceId.get(payload.deviceId)?.peripheralId ??
          knownNodesByDeviceId.get(payload.deviceId)?.peripheralId ??
          null,
        address:
          peripheralInfo.address ??
          runtimeByDeviceId.get(payload.deviceId)?.address ??
          knownNodesByDeviceId.get(payload.deviceId)?.lastKnownAddress ??
          null,
        gatewayLastTelemetryAt: telemetryAt,
        gatewayLastAdvertisementAt:
          runtimeByDeviceId.get(payload.deviceId)?.gatewayLastAdvertisementAt ?? telemetryAt,
        advertisedName: peripheralInfo.localName ?? null,
        lastRssi: peripheralInfo.rssi ?? null,
        lastState: payload.state,
        lastSeenAt: payload.timestamp,
        lastDelta: payload.delta ?? null,
        firmwareVersion: payload.firmwareVersion ?? "unknown",
        bootId: payload.bootId ?? null,
        hardwareId: payload.hardwareId ?? null,
      });

      upsertKnownNode(payload.deviceId, {
        deviceId: payload.deviceId,
        hardwareId: payload.hardwareId ?? null,
        peripheralId: peripheralInfo.peripheralId ?? null,
        lastKnownAddress: peripheralInfo.address ?? null,
        lastAdvertisedName: peripheralInfo.localName ?? null,
        lastConnectedAt:
          runtimeByDeviceId.get(payload.deviceId)?.gatewayLastConnectedAt ?? telemetryAt,
        lastSeenAt: telemetryAt,
        machineLabel: metadataByDeviceId.get(payload.deviceId)?.machineLabel ?? null,
        siteId: metadataByDeviceId.get(payload.deviceId)?.siteId ?? null,
        firmwareVersion: payload.firmwareVersion ?? "unknown",
      });
      upsertDiscovery({
        peripheralId: peripheralInfo.peripheralId ?? null,
        address: peripheralInfo.address ?? null,
        localName: peripheralInfo.localName ?? null,
        rssi: peripheralInfo.rssi ?? null,
        knownDeviceId: payload.deviceId,
      });

      if (peripheralInfo.peripheralId) {
        deviceIdByPeripheralId.set(peripheralInfo.peripheralId, payload.deviceId);
      }

      await refreshMetadata(!metadataByDeviceId.has(payload.deviceId));
      emitDevice(payload.deviceId);
      broadcastGatewayStatus();
      return {
        before: previous,
        after: inspectNodeConnection({ deviceId: payload.deviceId }),
      };
    },

    noteDisconnected({
      deviceId = null,
      knownDeviceId = null,
      peripheralId,
      localName,
      address,
      reason,
      reconnectAttempt = null,
      reconnectAttemptLimit = null,
      reconnectRetryExhausted = null,
    }) {
      const previous = inspectNodeConnection({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });
      const resolvedDeviceId = resolveKnownDeviceIdByDiscovery({
        deviceId,
        knownDeviceId,
        peripheralId,
        localName,
        address,
      });

      if (!resolvedDeviceId) {
        return {
          applied: false,
          before: previous,
          after: null,
        };
      }

      updateRuntimeNode(resolvedDeviceId, {
        peripheralId,
        address: address ?? null,
        gatewayConnectionState: "disconnected",
        gatewayLastDisconnectedAt: nowIso(),
        gatewayDisconnectReason: reason ?? "ble-disconnected",
        reconnectAttempt:
          reconnectAttempt ?? runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttempt ?? 0,
        reconnectAttemptLimit:
          reconnectAttemptLimit ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectAttemptLimit ??
          20,
        reconnectRetryExhausted:
          reconnectRetryExhausted ??
          runtimeByDeviceId.get(resolvedDeviceId)?.reconnectRetryExhausted ??
          false,
      });
      emitDevice(resolvedDeviceId);
      broadcastGatewayStatus();
      return {
        applied: true,
        before: previous,
        after: inspectNodeConnection({ deviceId: resolvedDeviceId }),
      };
    },

    noteOtaStatus(deviceId, patch) {
      if (!deviceId) {
        return;
      }

      const previous = runtimeByDeviceId.get(deviceId) ?? {};

      updateRuntimeNode(deviceId, {
        otaStatus: patch.otaStatus ?? previous.otaStatus ?? "idle",
        otaTargetVersion:
          patch.otaTargetVersion !== undefined
            ? patch.otaTargetVersion
            : previous.otaTargetVersion ?? null,
        otaProgressBytesSent:
          patch.otaProgressBytesSent !== undefined
            ? patch.otaProgressBytesSent
            : previous.otaProgressBytesSent ?? null,
        otaTotalBytes:
          patch.otaTotalBytes !== undefined
            ? patch.otaTotalBytes
            : previous.otaTotalBytes ?? null,
        otaLastPhase:
          patch.otaLastPhase !== undefined
            ? patch.otaLastPhase
            : previous.otaLastPhase ?? null,
        otaFailureDetail:
          patch.otaFailureDetail !== undefined
            ? patch.otaFailureDetail
            : previous.otaFailureDetail ?? null,
        otaLastStatusMessage:
          patch.otaLastStatusMessage !== undefined
            ? patch.otaLastStatusMessage
            : previous.otaLastStatusMessage ?? null,
        otaUpdatedAt: nowIso(),
      });
      emitDevice(deviceId);
      broadcastGatewayStatus();
    },

    resolveKnownDeviceId(input) {
      return resolveKnownDeviceIdByDiscovery(input);
    },
    inspectNodeConnection,
  };
}
