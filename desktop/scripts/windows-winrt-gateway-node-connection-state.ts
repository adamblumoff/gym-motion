// @ts-nocheck
import { describeNode as defaultDescribeNode } from "./windows-winrt-gateway-node.js";

export async function handleNodeConnectionStateEvent({
  event,
  runtimeBridge,
  runtimeServer,
  emitGatewayState,
  emitRuntimeDeviceUpdated,
  describeNode = defaultDescribeNode,
}) {
  await runtimeBridge.handleNodeConnectionState(event);
  emitGatewayState();
  emitRuntimeDeviceUpdated(runtimeServer.resolveKnownDeviceId(describeNode(event.node ?? {})));
}
