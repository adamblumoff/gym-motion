import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
  DeviceActivitySummary,
  DiscoveredNodeSummary,
  GatewayConnectionState,
  GatewayRuntimeDeviceSummary,
  HealthStatus,
  MotionEventSummary,
} from "@core/contracts";

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
  healthStatus: HealthStatus;
  isMoving: boolean;
  signalStrength: number | null;
  batteryLevel: number | null;
  logs: NodeLog[];
};

export type SetupDevice = {
  id: string;
  name: string;
  macAddress: string | null;
  signalStrength: number | null;
  isPaired: boolean;
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
  return device.peripheralId ?? device.id;
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

export function buildBluetoothNodes(snapshot: DesktopSnapshot): BluetoothNodeData[] {
  return snapshot.devices.map((device) => ({
    id: device.id,
    name: displayNodeName(device),
    macAddress: displayNodeAddress(device),
    isConnected: device.gatewayConnectionState === "connected",
    connectionState: device.gatewayConnectionState,
    healthStatus: device.healthStatus,
    isMoving:
      device.lastState === "moving" &&
      (device.gatewayConnectionState === "connected" ||
        device.gatewayConnectionState === "connecting" ||
        device.gatewayConnectionState === "reconnecting"),
    signalStrength: rssiToPercent(device.lastRssi),
    batteryLevel: null,
    logs: buildNodeLogs(device, snapshot.activities),
  }));
}

export function buildSetupVisibleDevices(
  setup: DesktopSetupState,
  approvedNodes: ApprovedNodeRule[],
): SetupDevice[] {
  const visibleNodes =
    setup.nodes.length > 0
      ? setup.nodes
      : approvedNodes.map((node) => ({
          id: node.id,
          label: node.label,
          peripheralId: node.peripheralId,
          address: node.address,
          localName: node.localName,
          knownDeviceId: node.knownDeviceId,
          machineLabel: null,
          siteId: null,
          lastRssi: null,
          lastSeenAt: null,
          gatewayConnectionState: "visible" as const,
          isApproved: true,
        }));

  return visibleNodes.map((node) => ({
    id: node.id,
    name: displayDiscoveryName(node),
    macAddress: displayDiscoveryAddress(node),
    signalStrength: rssiToPercent(node.lastRssi),
    isPaired: approvedNodes.some((approvedNode) => approvedNode.id === node.id),
  }));
}

export function buildPairedDevices(setup: DesktopSetupState): SetupDevice[] {
  return setup.approvedNodes.map((node) => ({
    id: node.id,
    name: node.label,
    macAddress: node.address ?? node.peripheralId ?? node.knownDeviceId ?? node.id,
    signalStrength: null,
    isPaired: true,
  }));
}

export function buildSignalHistory(
  events: MotionEventSummary[],
  nodes: BluetoothNodeData[],
) {
  const activeNodes = nodes.slice(0, 5);
  const sortedEvents = [...events].sort((left, right) => left.eventTimestamp - right.eventTimestamp);

  type SignalBucket = {
    time: string;
    sensorA: number;
    sensorB: number;
    sensorC: number;
    sensorD: number;
    sensorE: number;
  };
  type SignalKey = "sensorA" | "sensorB" | "sensorC" | "sensorD" | "sensorE";

  return sortedEvents.map((event, index) => {
    const node = activeNodes.find((item) => item.id === event.deviceId);
    const bucket: SignalBucket = {
      time: new Date(event.receivedAt).toLocaleTimeString("en-US", {
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
      const activeEvents = sortedEvents.filter((item) => item.deviceId === activeNode.id);
      const eventForNode =
        activeEvents[Math.min(index, Math.max(0, activeEvents.length - 1))] ?? null;
      const level = eventForNode
        ? Math.max(8, Math.min(100, (eventForNode.delta ?? fallbackSignal) + 25))
        : fallbackSignal;
      const key = `sensor${String.fromCharCode(65 + nodeIndex)}` as SignalKey;
      bucket[key] = level;
    });

    if (node && activeNodes.length === 1) {
      bucket.sensorA = node.signalStrength ?? 0;
    }

    return bucket;
  });
}

export function buildMovementData(events: MotionEventSummary[]) {
  const byHour = new Map<string, number>();

  for (const event of events) {
    const hour = new Date(event.receivedAt).toLocaleTimeString("en-US", {
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
