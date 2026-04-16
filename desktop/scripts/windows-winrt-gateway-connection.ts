// @ts-nocheck
import { createDeviceContext, describeNode } from "./windows-winrt-gateway-node.js";

export function getGatewayConnectionState(event) {
  return event.gateway_connection_state ?? event.gatewayConnectionState ?? "disconnected";
}

export function applyNodeConnectionStateEvent(
  event,
  { runtimeServer, deviceContexts, emitGatewayState, emitRuntimeDeviceUpdated },
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
    runtimeServer.resolveKnownDeviceId(peripheralInfo) ??
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

  const updatedDeviceId = knownDeviceId ?? runtimeServer.resolveKnownDeviceId(peripheralInfo);
  emitGatewayState();
  emitRuntimeDeviceUpdated(updatedDeviceId);

  return updatedDeviceId;
}
