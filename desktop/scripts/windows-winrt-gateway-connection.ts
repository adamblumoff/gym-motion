import type {
  DiscoveryLocator,
  RuntimeGatewayTransitionState,
} from "../../backend/runtime/gateway-runtime-server/runtime-types.js";
import type {
  GatewayConnectionStateEvent,
  GatewayDeviceContext,
  GatewayRuntimeServer,
} from "./windows-winrt-gateway-types.js";
import { createDeviceContext, describeNode } from "./windows-winrt-gateway-node.js";

type GatewayConnectionStateHandlerDeps = {
  runtimeServer: Pick<
    GatewayRuntimeServer,
    "applyGatewayConnectionState" | "resolveKnownDeviceId"
  >;
  deviceContexts: Map<string, GatewayDeviceContext>;
  emitGatewayState: () => void;
  emitRuntimeDeviceUpdated: (deviceId: string | null | undefined) => void;
};

export function getGatewayConnectionState(
  event: GatewayConnectionStateEvent,
): RuntimeGatewayTransitionState {
  const state = event.gateway_connection_state ?? event.gatewayConnectionState;

  if (state === "connecting" || state === "reconnecting" || state === "connected") {
    return state;
  }

  return "disconnected";
}

export function applyNodeConnectionStateEvent(
  event: GatewayConnectionStateEvent,
  { runtimeServer, deviceContexts, emitGatewayState, emitRuntimeDeviceUpdated }: GatewayConnectionStateHandlerDeps,
) {
  const node = event.node ?? {};
  const connectionState = getGatewayConnectionState(event);
  const peripheralInfo = describeNode(node);
  const payload = {
    ...peripheralInfo,
    reconnectAttempt: null,
    reconnectAttemptLimit: null,
    reconnectRetryExhausted: false,
      reconnectAwaitingDecision: false,
  };

  const knownDeviceId =
    node.knownDeviceId ??
    node.known_device_id ??
    runtimeServer.resolveKnownDeviceId(peripheralInfo as DiscoveryLocator) ??
    null;

  if (knownDeviceId) {
    const context = deviceContexts.get(knownDeviceId) ?? createDeviceContext(knownDeviceId);
    context.peripheralId = payload.peripheralId ?? context.peripheralId ?? null;
    context.address = payload.address ?? context.address ?? null;
    context.advertisedName = payload.localName ?? context.advertisedName ?? null;
    context.rssi = payload.rssi ?? context.rssi ?? null;
    deviceContexts.set(knownDeviceId, context);
  }

  runtimeServer.applyGatewayConnectionState({
    connectionState,
    ...payload,
    reason: event.reason ?? "ble-disconnected",
  });

  const updatedDeviceId =
    knownDeviceId ??
    runtimeServer.resolveKnownDeviceId(peripheralInfo as DiscoveryLocator);
  emitGatewayState();
  emitRuntimeDeviceUpdated(updatedDeviceId);

  return updatedDeviceId;
}
