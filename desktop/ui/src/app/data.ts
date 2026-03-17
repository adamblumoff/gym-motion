import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceActivitySummary,
  DiscoveredNodeSummary,
  GatewayConnectionState,
  GatewayRuntimeDeviceSummary,
  MotionEventSummary,
} from "@core/contracts";
import {
  findMatchingGatewayDeviceForApprovedNode,
  matchesApprovedNodeIdentity as matchesApprovedNodeIdentityFromCore,
} from "@core/approved-node-runtime-match";
import { matchesApprovedNodeIdentity } from "../lib/setup-rules";

export type NodeLog = {
  id: string;
  timestamp: Date;
  message: string;
  isMoving: boolean;
};

export type BluetoothNodeData = {
  id: string;
  name: string;
  macAddress: string | null;
  isConnected: boolean;
  connectionState: GatewayConnectionState;
  isMoving: boolean;
  signalStrength: number | null;
  batteryLevel: number | null;
  reconnectAttempt: number;
  reconnectAttemptLimit: number;
  reconnectRetryExhausted: boolean;
  reconnectAwaitingDecision: boolean;
  logs: NodeLog[];
};

export type SetupDevice = {
  id: string;
  name: string;
  macAddress: string | null;
  signalStrength: number | null;
  isPaired: boolean;
  connectionState: GatewayConnectionState | "visible";
  reconnectAttempt: number;
  reconnectAttemptLimit: number;
  reconnectRetryExhausted: boolean;
  reconnectAwaitingDecision: boolean;
  lastDisconnectReason: string | null;
};

function rssiToPercent(rssi: number | null) {
  if (rssi === null) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(((rssi + 100) / 45) * 100)));
}

function displayNodeName(device: GatewayRuntimeDeviceSummary) {
  return (
    device.machineLabel ??
    device.siteId ??
    device.advertisedName ??
    device.id
  );
}

function displayNodeAddress(device: GatewayRuntimeDeviceSummary) {
  return device.address ?? device.peripheralId ?? device.id;
}

function displayDiscoveryName(node: Pick<DiscoveredNodeSummary, "machineLabel" | "localName" | "knownDeviceId" | "label" | "id">) {
  return node.machineLabel ?? node.localName ?? node.knownDeviceId ?? node.label ?? node.id;
}

function displayDiscoveryAddress(
  node: Pick<DiscoveredNodeSummary, "address" | "peripheralId" | "knownDeviceId" | "id">,
) {
  return node.address ?? node.peripheralId ?? node.knownDeviceId ?? node.id;
}

function buildNodeLogs(
  device: GatewayRuntimeDeviceSummary,
  activities: DeviceActivitySummary[],
) {
  return activities
    .filter((activity) => activity.deviceId === device.id)
    .slice(0, 15)
    .map((activity) => ({
      id: activity.id,
      timestamp: new Date(activity.receivedAt),
      message: activity.message,
      isMoving: activity.state === "moving",
    }));
}

export function shouldDisplayDashboardDevice(
  device: GatewayRuntimeDeviceSummary,
  approvedNodes?: ApprovedNodeRule[],
) {
  if (approvedNodes === undefined) {
    return true;
  }

  return approvedNodes.some((approvedNode) =>
    matchesApprovedNodeIdentityFromCore(
      approvedNode,
      {
        knownDeviceId: device.id,
        peripheralId: device.peripheralId ?? null,
        address: device.address ?? null,
        localName: device.advertisedName ?? null,
      },
      approvedNodes,
    ),
  );
}

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
    isMoving: device.gatewayConnectionState === "connected" && device.lastState === "moving",
    signalStrength: rssiToPercent(device.lastRssi),
    batteryLevel: null,
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
      matchesApprovedNodeIdentity(approvedNode, {
        peripheralId: node.peripheralId ?? null,
        address: node.address ?? null,
        localName: node.localName ?? null,
        knownDeviceId: node.knownDeviceId ?? null,
      }, approvedNodes),
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

export function buildSignalHistory(
  events: MotionEventSummary[],
  nodes: BluetoothNodeData[],
) {
  const activeNodes = [...nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 5);
  const sortedEvents = [...events].sort((left, right) => left.eventTimestamp - right.eventTimestamp);
  const eventsByDeviceId = new Map<string, MotionEventSummary[]>();

  for (const event of sortedEvents) {
    const existing = eventsByDeviceId.get(event.deviceId) ?? [];
    existing.push(event);
    eventsByDeviceId.set(event.deviceId, existing);
  }

  type SignalBucket = {
    time: string;
    sensorA: number;
    sensorB: number;
    sensorC: number;
    sensorD: number;
    sensorE: number;
  };
  type SignalKey = "sensorA" | "sensorB" | "sensorC" | "sensorD" | "sensorE";

  return sortedEvents.map((event) => {
    const bucket: SignalBucket = {
      time: new Date(event.eventTimestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      }),
      sensorA: 0,
      sensorB: 0,
      sensorC: 0,
      sensorD: 0,
      sensorE: 0,
    };

    activeNodes.forEach((activeNode, nodeIndex) => {
      const fallbackSignal = activeNode.signalStrength ?? 0;
      const activeEvents = eventsByDeviceId.get(activeNode.id) ?? [];
      let eventForNode: MotionEventSummary | null = null;

      for (const candidate of activeEvents) {
        if (candidate.eventTimestamp > event.eventTimestamp) {
          break;
        }

        eventForNode = candidate;
      }

      const level = eventForNode
        ? Math.max(8, Math.min(100, (eventForNode.delta ?? fallbackSignal) + 25))
        : fallbackSignal;
      const key = `sensor${String.fromCharCode(65 + nodeIndex)}` as SignalKey;
      bucket[key] = level;
    });

    return bucket;
  });
}

export function buildMovementData(events: MotionEventSummary[]) {
  const byHour = new Map<string, number>();

  for (const event of events) {
    const hour = new Date(event.eventTimestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
    });
    const key = `${hour}:00`;
    byHour.set(key, (byHour.get(key) ?? 0) + 1);
  }

  return [...byHour.entries()]
    .map(([hour, movements]) => ({ hour, movements }))
    .sort((left, right) => left.hour.localeCompare(right.hour));
}

export function buildUptimeData(nodes: BluetoothNodeData[]) {
  return nodes.map((node, index) => ({
    name: node.name,
    uptime: node.isConnected ? 100 : 0,
    fill: ["#3b82f6", "#06b6d4", "#8b5cf6", "#3b82f680", "#06b6d480"][index % 5] ?? "#3b82f6",
  }));
}

export function buildBatteryData(nodes: BluetoothNodeData[]) {
  return nodes.map((node, index) => ({
    name: node.name,
    level: node.batteryLevel,
    fill: ["#3b82f6", "#06b6d4", "#8b5cf6", "#f59e0b", "#06b6d4"][index % 5] ?? "#3b82f6",
  }));
}

export function calculateAverageSignal(latestSignal: {
  sensorA: number;
  sensorB: number;
  sensorC: number;
  sensorD: number;
  sensorE: number;
} | null) {
  const signalValues = latestSignal
    ? [
        latestSignal.sensorA,
        latestSignal.sensorB,
        latestSignal.sensorC,
        latestSignal.sensorD,
        latestSignal.sensorE,
      ].filter((value) => value > 0)
    : [];

  return Math.round(
    signalValues.length > 0
      ? signalValues.reduce((sum, value) => sum + value, 0) / signalValues.length
      : 0,
  );
}
