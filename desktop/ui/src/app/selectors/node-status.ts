import type { GatewayConnectionState } from "@core/contracts";

export type CanonicalNodeStatus =
  | "sensor_fault"
  | "reconnecting"
  | "disconnected"
  | "moving"
  | "still";

export function isBlockingSensorIssue(sensorIssue: string | null) {
  return sensorIssue !== null && sensorIssue !== "sensor_no_data";
}

type NodeStatusInput = {
  connectionState: GatewayConnectionState;
  lastState: "moving" | "still";
  sensorIssue: string | null;
};

export function canonicalNodeStatus({
  connectionState,
  lastState,
  sensorIssue,
}: NodeStatusInput): CanonicalNodeStatus {
  if (isBlockingSensorIssue(sensorIssue)) {
    return "sensor_fault";
  }

  if (connectionState === "connecting" || connectionState === "reconnecting") {
    return "reconnecting";
  }

  if (connectionState !== "connected") {
    return "disconnected";
  }

  return lastState === "moving" ? "moving" : "still";
}

export function canonicalNodeStatusLabel(status: CanonicalNodeStatus) {
  switch (status) {
    case "sensor_fault":
      return "Sensor fault";
    case "reconnecting":
      return "Reconnecting";
    case "disconnected":
      return "Disconnected";
    case "moving":
      return "Moving";
    default:
      return "Still";
  }
}
