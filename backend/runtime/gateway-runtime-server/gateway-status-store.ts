import type { BleAdapterSummary, GatewayStatusSummary } from "@core/contracts";

type GatewayCounts = {
  knownNodeCount: number;
  connectedNodeCount: number;
  reconnectingNodeCount: number;
};

export function createGatewayStatusStore({
  sessionId,
  hostname,
  mode,
  nowIso,
  broadcast,
}: {
  sessionId: string;
  hostname: string;
  mode: GatewayStatusSummary["mode"];
  nowIso: () => string;
  broadcast: (event: string, payload: unknown) => void;
}) {
  let availableAdapters: BleAdapterSummary[] = [];
  let runtimeIssue: string | null = null;

  const gatewayState: GatewayStatusSummary = {
    hostname,
    mode,
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

  function touchGatewayState(counts: GatewayCounts, patch: Partial<GatewayStatusSummary> = {}) {
    Object.assign(gatewayState, patch, {
      updatedAt: nowIso(),
      knownNodeCount: counts.knownNodeCount,
      connectedNodeCount: counts.connectedNodeCount,
      reconnectingNodeCount: counts.reconnectingNodeCount,
    });
  }

  function getGatewayState() {
    return { ...gatewayState };
  }

  function setRuntimeIssue(issue: string | null) {
    runtimeIssue = typeof issue === "string" && issue.length > 0 ? issue : null;
  }

  function getRuntimeIssue() {
    return runtimeIssue;
  }

  function setAvailableAdapters(adapters: BleAdapterSummary[]) {
    availableAdapters = Array.isArray(adapters) ? adapters : [];
  }

  function getAvailableAdapters() {
    return [...availableAdapters];
  }

  function getGatewayStatusPayload() {
    return {
      ok: gatewayState.adapterState === "poweredOn" && runtimeIssue === null,
      gateway: gatewayState,
      error: runtimeIssue ?? undefined,
    };
  }

  function broadcastGatewayStatus() {
    broadcast("gateway-status", getGatewayStatusPayload());
  }

  return {
    gatewayState,
    touchGatewayState,
    getGatewayState,
    setRuntimeIssue,
    getRuntimeIssue,
    setAvailableAdapters,
    getAvailableAdapters,
    getGatewayStatusPayload,
    broadcastGatewayStatus,
  };
}
