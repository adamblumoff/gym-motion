import type { GatewayRuntimeDeviceSummary } from "@core/contracts";
import { latestTimestamp } from "./utils.js";
import type {
  EmitDevice,
  KnownNode,
  MergeDevice,
  RuntimeDeviceMetadata,
  RuntimeNode,
} from "./runtime-types.js";

export function createProjectionHelpers({
  metadataByDeviceId,
  runtimeByDeviceId,
  knownNodesByDeviceId,
  broadcast,
  nowIso,
  healthStatusFromRuntime,
  telemetryFreshnessFromTimestamp,
}: {
  metadataByDeviceId: Map<string, RuntimeDeviceMetadata>;
  runtimeByDeviceId: Map<string, RuntimeNode>;
  knownNodesByDeviceId: Map<string, KnownNode>;
  broadcast: (event: string, payload: { device: GatewayRuntimeDeviceSummary }) => void;
  nowIso: () => string;
  healthStatusFromRuntime: (connectionState: RuntimeNode["gatewayConnectionState"]) => GatewayRuntimeDeviceSummary["healthStatus"];
  telemetryFreshnessFromTimestamp: (
    timestamp: string | null,
  ) => GatewayRuntimeDeviceSummary["telemetryFreshness"];
}): { mergeDevice: MergeDevice; emitDevice: EmitDevice } {
  function mergeDevice(deviceId: string): GatewayRuntimeDeviceSummary {
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
      healthStatus: healthStatusFromRuntime(connectionState),
      gatewayConnectionState: connectionState,
      telemetryFreshness,
      peripheralId: runtime?.peripheralId ?? known?.peripheralId ?? null,
      address: runtime?.address ?? known?.lastKnownAddress ?? null,
      gatewayLastAdvertisementAt:
        runtime?.gatewayLastAdvertisementAt ?? known?.lastSeenAt ?? null,
      gatewayLastConnectedAt:
        runtime?.gatewayLastConnectedAt ?? known?.lastConnectedAt ?? null,
      gatewayLastDisconnectedAt: runtime?.gatewayLastDisconnectedAt ?? null,
      gatewayLastTelemetryAt: runtime?.gatewayLastTelemetryAt ?? null,
      gatewayDisconnectReason: runtime?.gatewayDisconnectReason ?? null,
      advertisedName: runtime?.advertisedName ?? known?.lastAdvertisedName ?? null,
      lastRssi: runtime?.lastRssi ?? null,
      sensorIssue: runtime?.sensorIssue ?? null,
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
      reconnectAwaitingDecision: runtime?.reconnectAwaitingDecision ?? false,
    };
  }

  function emitDevice(deviceId: string): void {
    if (!deviceId) {
      return;
    }

    const device = mergeDevice(deviceId);
    broadcast("gateway-device", { device });
  }

  return {
    mergeDevice,
    emitDevice,
  };
}
