// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";

export function createKnownNodeStore({
  knownNodesPath,
  knownNodesByDeviceId,
  deviceIdByPeripheralId,
  runtimeByDeviceId,
  emptyOtaRuntimeState,
  emptyReconnectRuntimeState,
  touchGatewayState,
  nowIso,
}) {
  let writeTimer = null;
  let persistPromise = null;

  async function persistKnownNodes() {
    if (persistPromise) {
      return persistPromise;
    }

    persistPromise = (async () => {
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
        persistPromise = null;
      }
    })();

    return persistPromise;
  }

  function schedulePersist() {
    if (writeTimer) {
      clearTimeout(writeTimer);
    }

    writeTimer = setTimeout(async () => {
      writeTimer = null;
      await persistKnownNodes();
    }, 150);
    writeTimer?.unref?.();
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

  function cancelPersist() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
  }

  return {
    loadKnownNodes,
    persistKnownNodes,
    schedulePersist,
    cancelPersist,
  };
}
