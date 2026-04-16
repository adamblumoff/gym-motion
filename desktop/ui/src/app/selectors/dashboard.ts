import type { ApprovedNodeRule, DesktopSnapshot } from "@core/contracts";

import {
  buildNodeLogs,
  displayNodeAddress,
  displayNodeName,
  indexNodeLogs,
  rssiToPercent,
  shouldDisplayDashboardDevice,
} from "./shared";
import {
  connectionStatusForNode,
  isActivelyMoving,
  motionStatusForNode,
  nodeVisualTone,
  sensorStatusForNode,
} from "./node-status";
import type { BluetoothNodeData } from "./types";

export function buildBluetoothNodes(
  snapshot: DesktopSnapshot,
  approvedNodes?: ApprovedNodeRule[],
): BluetoothNodeData[] {
  const nodeLogsByDeviceId = indexNodeLogs(snapshot.activities);

  return snapshot.devices
    .filter((device) => shouldDisplayDashboardDevice(device, approvedNodes))
    .map((device) => {
      const sensorIssue = device.sensorIssue ?? null;
      const connectionStatus = connectionStatusForNode({
        connectionState: device.gatewayConnectionState,
      });
      const sensorStatus = sensorStatusForNode({
        sensorIssue,
      });
      const motionStatus = motionStatusForNode({
        lastState: device.lastState,
      });

      return {
        id: device.id,
        name: displayNodeName(device),
        macAddress: displayNodeAddress(device),
        connectionState: device.gatewayConnectionState,
        connectionStatus,
        sensorStatus,
        motionStatus,
        visualTone: nodeVisualTone({
          connectionState: device.gatewayConnectionState,
          lastState: device.lastState,
          sensorIssue,
        }),
        isMoving: isActivelyMoving({
          connectionState: device.gatewayConnectionState,
          lastState: device.lastState,
          sensorIssue,
        }),
        lastState: device.lastState,
        sensorIssue,
        lastDelta: device.lastDelta,
        lastTelemetryAt: device.gatewayLastTelemetryAt,
        signalStrength: rssiToPercent(device.lastRssi),
        lastDisconnectReason:
          device.gatewayConnectionState === "disconnected"
            ? device.gatewayDisconnectReason ?? null
            : null,
        reconnectAttempt: device.reconnectAttempt,
        reconnectAttemptLimit: device.reconnectAttemptLimit,
        reconnectRetryExhausted: device.reconnectRetryExhausted,
        reconnectAwaitingDecision: device.reconnectAwaitingDecision ?? false,
        logs: nodeLogsByDeviceId.get(device.id) ?? buildNodeLogs(device, snapshot.activities),
      };
    });
}
