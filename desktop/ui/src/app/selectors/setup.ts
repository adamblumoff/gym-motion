import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
} from "@core/contracts";
import {
  findMatchingGatewayDeviceForApprovedNode,
} from "@core/approved-node-runtime-match";
import { matchesApprovedNodeIdentity } from "../../lib/setup-rules";

import {
  displayDiscoveryAddress,
  displayDiscoveryName,
  displayNodeName,
  rssiToPercent,
} from "./shared";
import type { SetupDevice } from "./types";

export function buildSetupVisibleDevices(
  setup: DesktopSetupState,
  approvedNodes: ApprovedNodeRule[],
): SetupDevice[] {
  return (setup.manualCandidates ?? []).map((node) => ({
    id: node.id,
    name: displayDiscoveryName(node),
    macAddress: displayDiscoveryAddress(node),
    signalStrength: rssiToPercent(node.lastRssi),
    isPaired: approvedNodes.some((approvedNode) =>
      matchesApprovedNodeIdentity(
        approvedNode,
        {
          peripheralId: node.peripheralId ?? null,
          address: node.address ?? null,
          localName: node.localName ?? null,
          knownDeviceId: node.knownDeviceId ?? null,
        },
        approvedNodes,
      ),
    ),
    connectionState: "visible",
    reconnectAttempt: 0,
    reconnectAttemptLimit: 20,
    reconnectRetryExhausted: false,
    reconnectAwaitingDecision: false,
    lastDisconnectReason: null,
  }));
}

export function buildPairedDevices(
  setup: DesktopSetupState,
  snapshot: DesktopSnapshot | null = null,
): SetupDevice[] {
  return setup.approvedNodes.map((node) => {
    const runtimeDevice = snapshot
      ? findMatchingGatewayDeviceForApprovedNode(node, snapshot.devices, setup.approvedNodes)
      : null;

    return {
      id: node.id,
      name: runtimeDevice ? displayNodeName(runtimeDevice) : node.label,
      macAddress:
        node.address ??
        runtimeDevice?.address ??
        node.peripheralId ??
        runtimeDevice?.peripheralId ??
        node.knownDeviceId ??
        node.id,
      signalStrength: runtimeDevice ? rssiToPercent(runtimeDevice.lastRssi) : null,
      isPaired: true,
      connectionState: runtimeDevice?.gatewayConnectionState ?? "disconnected",
      reconnectAttempt: runtimeDevice?.reconnectAttempt ?? 0,
      reconnectAttemptLimit: runtimeDevice?.reconnectAttemptLimit ?? 20,
      reconnectRetryExhausted: runtimeDevice?.reconnectRetryExhausted ?? false,
      reconnectAwaitingDecision: runtimeDevice?.reconnectAwaitingDecision ?? false,
      lastDisconnectReason:
        runtimeDevice?.gatewayConnectionState === "disconnected"
          ? runtimeDevice.gatewayDisconnectReason ?? null
          : null,
    };
  });
}
