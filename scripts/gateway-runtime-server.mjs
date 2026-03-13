import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const METADATA_REFRESH_MS = 15_000;
const STREAM_PING_MS = 15_000;
const DEFAULT_KNOWN_NODE_DIR = path.join(process.cwd(), "data");

function nowIso() {
  return new Date().toISOString();
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

function healthStatusFromConnectionState(connectionState) {
  if (connectionState === "connected") {
    return "online";
  }

  if (
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
  const streamClients = new Set();
  let metadataLoadedAt = 0;
  let knownNodesWriteTimer = null;
  let server = null;

  const gatewayState = {
    hostname: os.hostname(),
    mode: "reference-ble-node-gateway",
    sessionId,
    adapterState: "unknown",
    scanState: "idle",
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
      ok: gatewayState.adapterState === "poweredOn",
      gateway: gatewayState,
    });
  }

  function scheduleKnownNodesPersist() {
    if (knownNodesWriteTimer) {
      clearTimeout(knownNodesWriteTimer);
    }

    knownNodesWriteTimer = setTimeout(async () => {
      knownNodesWriteTimer = null;

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
      }
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
      healthStatus: healthStatusFromConnectionState(connectionState),
      gatewayConnectionState: connectionState,
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

  function updateRuntimeNode(deviceId, patch) {
    if (!deviceId) {
      return;
    }

    const previous = runtimeByDeviceId.get(deviceId) ?? {
      gatewayConnectionState: "discovered",
      peripheralId: patch.peripheralId ?? null,
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

  async function getDevicesPayload() {
    await refreshMetadata();

    const deviceIds = new Set([
      ...knownNodesByDeviceId.keys(),
      ...runtimeByDeviceId.keys(),
      ...metadataByDeviceId.keys(),
    ]);

    return {
      ok: gatewayState.adapterState === "poweredOn",
      gateway: gatewayState,
      devices: sortDevices(Array.from(deviceIds, mergeDevice)),
    };
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      touchGatewayState();
      jsonResponse(response, 200, {
        ok: gatewayState.adapterState === "poweredOn",
        gateway: gatewayState,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      jsonResponse(response, 200, await getDevicesPayload());
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
          ok: gatewayState.adapterState === "poweredOn",
          gateway: gatewayState,
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
          updateRuntimeNode(deviceId, { gatewayConnectionState: "reconnecting" });
          emitDevice(deviceId);
        }
      }

      broadcastGatewayStatus();
    },

    setScanState(scanState) {
      touchGatewayState({ scanState });
      broadcastGatewayStatus();
    },

    noteDiscovery({ peripheralId, address, localName, rssi }) {
      const timestamp = nowIso();
      touchGatewayState({ lastAdvertisementAt: timestamp });
      const knownDeviceId = resolveKnownDeviceId(peripheralId);

      if (!knownDeviceId) {
        broadcastGatewayStatus();
        return;
      }

      updateRuntimeNode(knownDeviceId, {
        peripheralId,
        gatewayConnectionState: "reconnecting",
        gatewayLastAdvertisementAt: timestamp,
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
      });
      emitDevice(knownDeviceId);
      broadcastGatewayStatus();

      upsertKnownNode(knownDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
        lastSeenAt: timestamp,
      });
    },

    noteConnecting({ peripheralId, address, localName, rssi }) {
      const knownDeviceId = resolveKnownDeviceId(peripheralId);

      if (!knownDeviceId) {
        return;
      }

      updateRuntimeNode(knownDeviceId, {
        peripheralId,
        gatewayConnectionState: "connecting",
        gatewayLastAdvertisementAt: nowIso(),
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
      });
      upsertKnownNode(knownDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastKnownAddress: address ?? null,
      });
      emitDevice(knownDeviceId);
      broadcastGatewayStatus();
    },

    noteConnected({ peripheralId, localName, rssi }) {
      const knownDeviceId = resolveKnownDeviceId(peripheralId);

      if (!knownDeviceId) {
        return;
      }

      updateRuntimeNode(knownDeviceId, {
        peripheralId,
        gatewayConnectionState: "connected",
        gatewayLastConnectedAt: nowIso(),
        gatewayDisconnectReason: null,
        advertisedName: localName ?? null,
        lastRssi: rssi ?? null,
      });
      upsertKnownNode(knownDeviceId, {
        peripheralId,
        lastAdvertisedName: localName ?? null,
        lastConnectedAt: nowIso(),
      });
      emitDevice(knownDeviceId);
      broadcastGatewayStatus();
    },

    async noteTelemetry(payload, peripheralInfo = {}) {
      const telemetryAt = nowIso();

      updateRuntimeNode(payload.deviceId, {
        peripheralId:
          peripheralInfo.peripheralId ??
          runtimeByDeviceId.get(payload.deviceId)?.peripheralId ??
          knownNodesByDeviceId.get(payload.deviceId)?.peripheralId ??
          null,
        gatewayConnectionState: "connected",
        gatewayLastConnectedAt:
          runtimeByDeviceId.get(payload.deviceId)?.gatewayLastConnectedAt ?? telemetryAt,
        gatewayLastTelemetryAt: telemetryAt,
        gatewayLastAdvertisementAt:
          runtimeByDeviceId.get(payload.deviceId)?.gatewayLastAdvertisementAt ?? telemetryAt,
        gatewayDisconnectReason: null,
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

      if (peripheralInfo.peripheralId) {
        deviceIdByPeripheralId.set(peripheralInfo.peripheralId, payload.deviceId);
      }

      await refreshMetadata(!metadataByDeviceId.has(payload.deviceId));
      emitDevice(payload.deviceId);
      broadcastGatewayStatus();
    },

    noteDisconnected({ peripheralId, reason }) {
      const deviceId = resolveKnownDeviceId(peripheralId);

      if (!deviceId) {
        return;
      }

      updateRuntimeNode(deviceId, {
        peripheralId,
        gatewayConnectionState:
          gatewayState.adapterState === "poweredOn" ? "reconnecting" : "disconnected",
        gatewayLastDisconnectedAt: nowIso(),
        gatewayDisconnectReason: reason ?? "ble-disconnected",
      });
      emitDevice(deviceId);
      broadcastGatewayStatus();
    },
  };
}
