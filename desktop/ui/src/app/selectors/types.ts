import type { GatewayConnectionState } from "@core/contracts";
import type {
  NodeConnectionStatus,
  NodeMotionStatus,
  NodeSensorStatus,
  NodeVisualTone,
} from "./node-status";

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
  connectionState: GatewayConnectionState;
  connectionStatus: NodeConnectionStatus;
  sensorStatus: NodeSensorStatus;
  motionStatus: NodeMotionStatus;
  visualTone: NodeVisualTone;
  isMoving: boolean;
  lastState: "moving" | "still";
  sensorIssue: string | null;
  lastDelta: number | null;
  lastTelemetryAt: string | null;
  signalStrength: number | null;
  lastDisconnectReason: string | null;
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

export type SignalHistorySeries = {
  id: string;
  deviceId: string;
  name: string;
  color: string;
};

export type SignalHistoryPoint = {
  time: string;
  [seriesId: string]: string | number;
};

export type SignalHistoryData = {
  series: SignalHistorySeries[];
  points: SignalHistoryPoint[];
};

export type MovementDataPoint = {
  hour: string;
  movements: number;
};
