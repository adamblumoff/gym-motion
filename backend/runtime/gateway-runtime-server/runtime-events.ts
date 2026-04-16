import type { GatewayStatusSummary } from "@core/contracts";
import { createRuntimeConnectionEventHandlers } from "./runtime-connection-events.js";
import { createRuntimeTelemetryEventHandlers } from "./runtime-telemetry-events.js";
import { createRuntimeDeviceAdminEventHandlers } from "./runtime-device-admin-events.js";
import type {
  DiscoveryLocator,
  DiscoveryUpsertPayload,
  EmitDevice,
  KnownNode,
  KnownNodeStore,
  NodeConnectionInspection,
  RuntimeDeviceMetadata,
  RuntimeNode,
  RuntimeNodePatch,
  TouchGatewayState,
} from "./runtime-types.js";

export function createRuntimeDeviceEventController({
  metadataByDeviceId,
  runtimeByDeviceId,
  knownNodesByDeviceId,
  suppressedDeviceIds,
  deviceIdByPeripheralId,
  gatewayState,
  knownNodeStore,
  refreshMetadata,
  touchGatewayState,
  broadcastGatewayStatus,
  upsertDiscovery,
  removeDiscoveryEntries,
  emitDevice,
  upsertKnownNode,
  resolveKnownDeviceIdByDiscovery,
  updateRuntimeNode,
  inspectNodeConnection,
  nowIso,
  reconnectDisconnectGraceMs,
}: {
  metadataByDeviceId: Map<string, RuntimeDeviceMetadata>;
  runtimeByDeviceId: Map<string, RuntimeNode>;
  knownNodesByDeviceId: Map<string, KnownNode>;
  suppressedDeviceIds: Set<string>;
  deviceIdByPeripheralId: Map<string, string>;
  gatewayState: GatewayStatusSummary;
  knownNodeStore: KnownNodeStore;
  refreshMetadata: (force?: boolean) => Promise<void>;
  touchGatewayState: TouchGatewayState;
  broadcastGatewayStatus: () => void;
  upsertDiscovery: (payload: DiscoveryUpsertPayload) => unknown;
  removeDiscoveryEntries: (
    payload: Required<
      Pick<DiscoveryLocator, "knownDeviceId" | "peripheralId" | "address" | "localName">
    >,
  ) => void;
  emitDevice: EmitDevice;
  upsertKnownNode: (deviceId: string | null | undefined, patch?: Partial<KnownNode>) => void;
  resolveKnownDeviceIdByDiscovery: (input: DiscoveryLocator) => string | null;
  updateRuntimeNode: (deviceId: string | null | undefined, patch: RuntimeNodePatch) => void;
  inspectNodeConnection: (input: DiscoveryLocator) => NodeConnectionInspection | null;
  nowIso: () => string;
  reconnectDisconnectGraceMs: number;
}) {
  const connectionEvents = createRuntimeConnectionEventHandlers({
    runtimeByDeviceId,
    knownNodesByDeviceId,
    gatewayState,
    knownNodeStore,
    touchGatewayState,
    broadcastGatewayStatus,
    upsertDiscovery,
    emitDevice,
    upsertKnownNode,
    resolveKnownDeviceIdByDiscovery,
    updateRuntimeNode,
    inspectNodeConnection,
    nowIso,
    reconnectDisconnectGraceMs,
  });

  const telemetryEvents = createRuntimeTelemetryEventHandlers({
    metadataByDeviceId,
    runtimeByDeviceId,
    knownNodesByDeviceId,
    deviceIdByPeripheralId,
    knownNodeStore,
    refreshMetadata,
    broadcastGatewayStatus,
    upsertDiscovery,
    emitDevice,
    upsertKnownNode,
    updateRuntimeNode,
    inspectNodeConnection,
    clearPendingReconnectDisconnect: connectionEvents.clearPendingReconnectDisconnect,
    nowIso,
  });

  const deviceAdminEvents = createRuntimeDeviceAdminEventHandlers({
    runtimeByDeviceId,
    knownNodesByDeviceId,
    suppressedDeviceIds,
    deviceIdByPeripheralId,
    knownNodeStore,
    touchGatewayState,
    broadcastGatewayStatus,
    removeDiscoveryEntries,
    resolveKnownDeviceIdByDiscovery,
    clearPendingReconnectDisconnect: connectionEvents.clearPendingReconnectDisconnect,
  });

  return {
    noteDiscovery: connectionEvents.noteDiscovery,
    applyGatewayConnectionState: connectionEvents.applyGatewayConnectionState,
    noteConnecting: connectionEvents.noteConnecting,
    noteConnected: connectionEvents.noteConnected,
    noteTelemetry: telemetryEvents.noteTelemetry,
    noteDisconnected: connectionEvents.noteDisconnected,
    clearReconnectDecision: connectionEvents.clearReconnectDecision,
    restoreApprovedDevice: deviceAdminEvents.restoreApprovedDevice,
    forgetDevice: deviceAdminEvents.forgetDevice,
    noteOtaStatus: telemetryEvents.noteOtaStatus,
    cancelPendingReconnectDisconnects: connectionEvents.cancelPendingReconnectDisconnects,
  };
}
