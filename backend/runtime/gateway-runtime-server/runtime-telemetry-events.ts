import type {
  DiscoveryUpsertPayload,
  EmitDevice,
  KnownNode,
  KnownNodeStore,
  NodeConnectionInspection,
  RuntimeNode,
  RuntimeNodePatch,
  RuntimeDeviceMetadata,
  TelemetryPayload,
  TelemetryPeripheralInfo,
} from "./runtime-types.js";

export function createRuntimeTelemetryEventHandlers({
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
  clearPendingReconnectDisconnect,
  nowIso,
}: {
  metadataByDeviceId: Map<string, RuntimeDeviceMetadata>;
  runtimeByDeviceId: Map<string, RuntimeNode>;
  knownNodesByDeviceId: Map<string, KnownNode>;
  deviceIdByPeripheralId: Map<string, string>;
  knownNodeStore: KnownNodeStore;
  refreshMetadata: (force?: boolean) => Promise<void>;
  broadcastGatewayStatus: () => void;
  upsertDiscovery: (payload: DiscoveryUpsertPayload) => unknown;
  emitDevice: EmitDevice;
  upsertKnownNode: (deviceId: string | null | undefined, patch?: Partial<KnownNode>) => void;
  updateRuntimeNode: (deviceId: string | null | undefined, patch: RuntimeNodePatch) => void;
  inspectNodeConnection: (input: { deviceId?: string | null }) => NodeConnectionInspection | null;
  clearPendingReconnectDisconnect: (deviceId: string | null | undefined) => unknown;
  nowIso: () => string;
}) {
  async function noteTelemetry(
    payload: TelemetryPayload,
    peripheralInfo: TelemetryPeripheralInfo = {},
  ) {
    const previous = inspectNodeConnection({ deviceId: payload.deviceId });
    const telemetryAt = nowIso();
    const previousRuntime = runtimeByDeviceId.get(payload.deviceId) ?? null;
    clearPendingReconnectDisconnect(payload.deviceId);
    const nextConnectionState =
      previousRuntime?.gatewayConnectionState === "connecting" ||
      previousRuntime?.gatewayConnectionState === "reconnecting"
        ? previousRuntime.gatewayConnectionState
        : "connected";

    updateRuntimeNode(payload.deviceId, {
      peripheralId:
        peripheralInfo.peripheralId ??
        previousRuntime?.peripheralId ??
        knownNodesByDeviceId.get(payload.deviceId)?.peripheralId ??
        null,
      address:
        peripheralInfo.address ??
        previousRuntime?.address ??
        knownNodesByDeviceId.get(payload.deviceId)?.lastKnownAddress ??
        null,
      gatewayConnectionState: nextConnectionState,
      gatewayLastConnectedAt: previousRuntime?.gatewayLastConnectedAt ?? telemetryAt,
      gatewayDisconnectReason: null,
      gatewayLastTelemetryAt: telemetryAt,
      gatewayLastAdvertisementAt: previousRuntime?.gatewayLastAdvertisementAt ?? telemetryAt,
      advertisedName: peripheralInfo.localName ?? null,
      lastRssi: peripheralInfo.rssi ?? null,
      lastState: payload.state,
      sensorIssue: payload.sensorIssue ?? null,
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
      lastConnectedAt: previousRuntime?.gatewayLastConnectedAt ?? telemetryAt,
      lastSeenAt: telemetryAt,
      machineLabel: metadataByDeviceId.get(payload.deviceId)?.machineLabel ?? null,
      siteId: metadataByDeviceId.get(payload.deviceId)?.siteId ?? null,
      firmwareVersion: payload.firmwareVersion ?? "unknown",
    });
    knownNodeStore.schedulePersist();
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
  }

  function noteOtaStatus(
    deviceId: string | null | undefined,
    patch: Partial<
      Pick<
        RuntimeNode,
        | "otaStatus"
        | "otaTargetVersion"
        | "otaProgressBytesSent"
        | "otaTotalBytes"
        | "otaLastPhase"
        | "otaFailureDetail"
        | "otaLastStatusMessage"
      >
    >,
  ) {
    if (!deviceId) {
      return;
    }

    const previous: Partial<RuntimeNode> = runtimeByDeviceId.get(deviceId) ?? {};

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
        patch.otaTotalBytes !== undefined ? patch.otaTotalBytes : previous.otaTotalBytes ?? null,
      otaLastPhase:
        patch.otaLastPhase !== undefined ? patch.otaLastPhase : previous.otaLastPhase ?? null,
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
  }

  return {
    noteTelemetry,
    noteOtaStatus,
  };
}
