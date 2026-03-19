import type {
  BleAdapterSummary,
  GatewayConnectionState,
  GatewayStatusSummary,
  ManualScanCandidateSummary,
  OtaRuntimeStatus,
} from "@core/contracts";

type GatewayChildPersistMessageType =
  | "persist-motion"
  | "persist-heartbeat"
  | "persist-device-log"
  | "persist-device-backfill";

export type GatewayChildPersistMessage = {
  messageId: string;
  type: GatewayChildPersistMessageType;
  deviceId: string;
  payload: unknown;
};

export type GatewayChildRuntimeDeviceMessage = {
  type: "runtime-device-updated";
  device: {
    deviceId: string;
    gatewayConnectionState: GatewayConnectionState;
    peripheralId: string | null;
    address: string | null;
    gatewayLastAdvertisementAt: string | null;
    gatewayLastConnectedAt: string | null;
    gatewayLastDisconnectedAt: string | null;
    gatewayLastTelemetryAt: string | null;
    gatewayDisconnectReason: string | null;
    advertisedName: string | null;
    lastRssi: number | null;
    lastState: "moving" | "still";
    lastSeenAt: number;
    lastDelta: number | null;
    firmwareVersion: string;
    bootId: string | null;
    hardwareId: string | null;
    otaStatus: OtaRuntimeStatus;
    otaTargetVersion: string | null;
    otaProgressBytesSent: number | null;
    otaTotalBytes: number | null;
    otaLastPhase: string | null;
    otaFailureDetail: string | null;
    otaLastStatusMessage: string | null;
    otaUpdatedAt: string | null;
    reconnectAttempt: number;
    reconnectAttemptLimit: number;
    reconnectRetryExhausted: boolean;
    reconnectAwaitingDecision: boolean;
    updatedAt: string;
  };
};

export type GatewayChildGatewayStateMessage = {
  type: "gateway-state";
  gateway: GatewayStatusSummary;
  issue: string | null;
};

export type GatewayChildAdaptersUpdatedMessage = {
  type: "adapters-updated";
  adapters: BleAdapterSummary[];
  issue: string | null;
};

export type GatewayChildManualScanUpdatedMessage = {
  type: "manual-scan-updated";
  payload: {
    state?: "idle" | "scanning" | "pairing" | "failed";
    pairingCandidateId?: string | null;
    error?: string | null;
    candidates?: ManualScanCandidateSummary[];
  };
};

export type GatewayChildRuntimeReadyMessage = {
  type: "runtime-ready";
  gateway: GatewayStatusSummary;
  issue: string | null;
  adapters: BleAdapterSummary[];
  manualScan: GatewayChildManualScanUpdatedMessage["payload"];
};

export type GatewayChildControlResponseMessage = {
  type: "control-response";
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type GatewayParentPersistAckMessage = {
  type: "persist-ack";
  messageId: string;
  ok: boolean;
  error?: string;
};

export type GatewayChildRuntimeMessage =
  | GatewayChildRuntimeDeviceMessage
  | GatewayChildGatewayStateMessage
  | GatewayChildAdaptersUpdatedMessage
  | GatewayChildManualScanUpdatedMessage
  | GatewayChildRuntimeReadyMessage
  | GatewayChildControlResponseMessage;

export type GatewayChildMessage = GatewayChildPersistMessage | GatewayChildRuntimeMessage;

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isPersistMessageType(input: unknown): input is GatewayChildPersistMessageType {
  return (
    input === "persist-motion" ||
    input === "persist-heartbeat" ||
    input === "persist-device-log" ||
    input === "persist-device-backfill"
  );
}

export function parseGatewayChildMessage(input: unknown): GatewayChildMessage | null {
  if (!isRecord(input) || typeof input.type !== "string") {
    return null;
  }

  if (isPersistMessageType(input.type)) {
    if (
      typeof input.messageId !== "string" ||
      input.messageId.trim().length === 0 ||
      typeof input.deviceId !== "string" ||
      input.deviceId.trim().length === 0
    ) {
      return null;
    }

    return {
      messageId: input.messageId,
      type: input.type,
      deviceId: input.deviceId,
      payload: input.payload,
    };
  }

  switch (input.type) {
    case "runtime-device-updated":
      return isRecord(input.device) ? (input as GatewayChildRuntimeDeviceMessage) : null;
    case "gateway-state":
    case "adapters-updated":
    case "manual-scan-updated":
    case "runtime-ready":
    case "control-response":
      return input as GatewayChildRuntimeMessage;
    default:
      return null;
  }
}
