type GatewayChildPersistMessageType =
  | "persist-motion"
  | "persist-heartbeat"
  | "persist-device-log"
  | "persist-device-backfill";

export type GatewayChildPersistMessage = {
  type: GatewayChildPersistMessageType;
  deviceId: string;
  payload: unknown;
};

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isMessageType(input: unknown): input is GatewayChildPersistMessageType {
  return (
    input === "persist-motion" ||
    input === "persist-heartbeat" ||
    input === "persist-device-log" ||
    input === "persist-device-backfill"
  );
}

export function parseGatewayChildPersistMessage(
  input: unknown,
): GatewayChildPersistMessage | null {
  if (!isRecord(input)) {
    return null;
  }

  const { type, deviceId, payload } = input;

  if (!isMessageType(type)) {
    return null;
  }

  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    return null;
  }

  return {
    type,
    deviceId,
    payload,
  };
}
