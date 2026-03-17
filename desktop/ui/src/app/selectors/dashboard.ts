import type { ApprovedNodeRule, DesktopSnapshot } from "@core/contracts";

import {
  buildNodeLogs,
  displayNodeAddress,
  displayNodeName,
  rssiToPercent,
  shouldDisplayDashboardDevice,
} from "./shared";
import type { BluetoothNodeData } from "./types";

export function buildBluetoothNodes(
  snapshot: DesktopSnapshot,
  approvedNodes?: ApprovedNodeRule[],
): BluetoothNodeData[] {
  return snapshot.devices
    .filter((device) => shouldDisplayDashboardDevice(device, approvedNodes))
    .map((device) => ({
      id: device.id,
      name: displayNodeName(device),
      macAddress: displayNodeAddress(device),
      isConnected: device.gatewayConnectionState === "connected",
      connectionState: device.gatewayConnectionState,
      isMoving:
        device.gatewayConnectionState === "connected" && device.lastState === "moving",
      signalStrength: rssiToPercent(device.lastRssi),
      reconnectAttempt: device.reconnectAttempt,
      reconnectAttemptLimit: device.reconnectAttemptLimit,
      reconnectRetryExhausted: device.reconnectRetryExhausted,
      reconnectAwaitingDecision: device.reconnectAwaitingDecision ?? false,
      logs: buildNodeLogs(device, snapshot.activities),
    }));
}

export function buildDashboardRuntimeStatus(totalApprovedNodes: number) {
  return totalApprovedNodes >= 1 ? "Gateway live" : "Waiting for BLE nodes";
}
