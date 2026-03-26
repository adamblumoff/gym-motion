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

export function createNodeConnectionStateEventQueue({
  runtimeBridge,
  runtimeServer,
  emitGatewayState,
  emitRuntimeDeviceUpdated,
  describeNode = defaultDescribeNode,
  onError,
}) {
  let pending = Promise.resolve();

  return function enqueueNodeConnectionStateEvent(event) {
    pending = pending
      .then(() =>
        handleNodeConnectionStateEvent({
          event,
          runtimeBridge,
          runtimeServer,
          emitGatewayState,
          emitRuntimeDeviceUpdated,
          describeNode,
        }),
      )
      .catch((error) => {
        onError?.(error);
      });

    return pending;
  };
}
