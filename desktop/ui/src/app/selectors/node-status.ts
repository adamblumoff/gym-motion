import type { GatewayConnectionState } from "@core/contracts";

export type NodeConnectionStatus =
  | "connected"
  | "reconnecting"
  | "disconnected";

export type NodeSensorStatus =
  | "healthy"
  | "waiting_for_sample"
  | "fault";

export type NodeMotionStatus = "moving" | "still";

export type NodeVisualTone = "idle" | "moving" | "warning" | "offline";

export function isBlockingSensorIssue(sensorIssue: string | null) {
  return sensorIssue !== null && sensorIssue !== "sensor_no_data";
}

type NodeStatusInput = {
  connectionState: GatewayConnectionState;
  lastState: NodeMotionStatus;
  sensorIssue: string | null;
};

export function connectionStatusForNode({
  connectionState,
}: Pick<NodeStatusInput, "connectionState">): NodeConnectionStatus {
  if (connectionState === "connected") {
    return "connected";
  }

  if (connectionState === "connecting" || connectionState === "reconnecting") {
    return "reconnecting";
  }

  return "disconnected";
}

export function sensorStatusForNode({
  sensorIssue,
}: Pick<NodeStatusInput, "sensorIssue">): NodeSensorStatus {
  if (isBlockingSensorIssue(sensorIssue)) {
    return "fault";
  }

  if (sensorIssue === "sensor_no_data") {
    return "waiting_for_sample";
  }

  return "healthy";
}

export function motionStatusForNode({
  lastState,
}: Pick<NodeStatusInput, "lastState">): NodeMotionStatus {
  return lastState === "moving" ? "moving" : "still";
}

export function nodeVisualTone({
  connectionState,
  lastState,
  sensorIssue,
}: NodeStatusInput): NodeVisualTone {
  const connectionStatus = connectionStatusForNode({ connectionState });
  const sensorStatus = sensorStatusForNode({ sensorIssue });
  const motionStatus = motionStatusForNode({ lastState });

  if (sensorStatus === "fault" || connectionStatus === "reconnecting") {
    return "warning";
  }

  if (connectionStatus === "disconnected") {
    return "offline";
  }

  if (motionStatus === "moving") {
    return "moving";
  }

  return "idle";
}

export function isActivelyMoving({
  connectionState,
  lastState,
  sensorIssue,
}: NodeStatusInput) {
  return (
    connectionStatusForNode({ connectionState }) === "connected" &&
    sensorStatusForNode({ sensorIssue }) === "healthy" &&
    motionStatusForNode({ lastState }) === "moving"
  );
}

export function connectionStatusLabel(status: NodeConnectionStatus) {
  switch (status) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    default:
      return "Disconnected";
  }
}

export function sensorStatusLabel(status: NodeSensorStatus) {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "waiting_for_sample":
      return "Waiting";
    default:
      return "Fault";
  }
}

export function motionStatusLabel(status: NodeMotionStatus) {
  return status === "moving" ? "Moving" : "Still";
}
