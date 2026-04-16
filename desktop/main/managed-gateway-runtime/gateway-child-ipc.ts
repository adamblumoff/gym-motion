import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  DeviceSummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  ManualScanCandidateSummary,
} from "@core/contracts";
import type { DesktopTestStepName } from "@core/services";

type GatewayChildPersistMessageType =
  | "persist-motion"
  | "persist-heartbeat"
  | "persist-device-log";

export type GatewayChildPersistMessage = {
  messageId: string;
  type: GatewayChildPersistMessageType;
  deviceId: string;
  payload: unknown;
};

export type GatewayChildRuntimeDeviceMessage = {
  type: "runtime-device-updated";
  device: GatewayRuntimeDeviceSummary;
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

export type GatewaySetDevicesMetadataCommand = {
  type: "set_devices_metadata";
  devices: DeviceSummary[];
};

export type GatewaySetAllowedNodesCommand = {
  type: "set_allowed_nodes";
  nodes: ApprovedNodeRule[];
};

export type GatewayStartManualScanCommand = {
  type: "start_manual_scan";
};

export type GatewayPairManualCandidateCommand = {
  type: "pair_manual_candidate";
  candidateId: string;
};

export type GatewayRecoverApprovedNodeCommand = {
  type: "recover_approved_node";
  ruleId: string;
};

export type GatewayResumeApprovedNodeReconnectCommand = {
  type: "resume_approved_node_reconnect";
  ruleId: string;
};

export type GatewayE2eStepCommand = {
  type: "e2e_step";
  name: DesktopTestStepName;
  payload?: unknown;
};

export type GatewayControlCommand =
  | GatewaySetDevicesMetadataCommand
  | GatewaySetAllowedNodesCommand
  | GatewayStartManualScanCommand
  | GatewayPairManualCandidateCommand
  | GatewayRecoverApprovedNodeCommand
  | GatewayResumeApprovedNodeReconnectCommand
  | GatewayE2eStepCommand;

export type GatewayParentControlMessage = GatewayControlCommand & {
  commandId: string;
};

export type GatewaySetAllowedNodesResult =
  | {
      approvedCount: number;
      removedCount: number;
      forgottenCount: number;
    }
  | {
      nodeCount: number;
    };

export type GatewayControlResultByType = {
  set_devices_metadata: {
    deviceCount: number;
  };
  set_allowed_nodes: GatewaySetAllowedNodesResult;
  start_manual_scan: void;
  pair_manual_candidate: {
    candidateId: string;
  };
  recover_approved_node: {
    ruleId: string | null;
  };
  resume_approved_node_reconnect: {
    ruleId: string | null;
  };
  e2e_step: unknown;
};

export type GatewayControlCommandResult<TCommand extends GatewayControlCommand> =
  GatewayControlResultByType[TCommand["type"]];

export type GatewayChildControlResponseMessage = {
  type: "control-response";
  commandId: string;
  ok: boolean;
  result?: GatewayControlResultByType[keyof GatewayControlResultByType];
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

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

function isPersistMessageType(input: unknown): input is GatewayChildPersistMessageType {
  return (
    input === "persist-motion" ||
    input === "persist-heartbeat" ||
    input === "persist-device-log"
  );
}

function isApprovedNodeRule(input: unknown): input is ApprovedNodeRule {
  return isRecord(input) && isNonEmptyString(input.id);
}

function isDeviceSummary(input: unknown): input is DeviceSummary {
  return isRecord(input) && isNonEmptyString(input.id);
}

export function parseGatewayControlCommand(input: unknown): GatewayControlCommand | null {
  if (!isRecord(input) || typeof input.type !== "string") {
    return null;
  }

  switch (input.type) {
    case "set_devices_metadata":
      return Array.isArray(input.devices) && input.devices.every(isDeviceSummary)
        ? {
            type: input.type,
            devices: input.devices,
          }
        : null;
    case "set_allowed_nodes":
      return Array.isArray(input.nodes) && input.nodes.every(isApprovedNodeRule)
        ? {
            type: input.type,
            nodes: input.nodes,
          }
        : null;
    case "start_manual_scan":
      return {
        type: input.type,
      };
    case "pair_manual_candidate":
      return isNonEmptyString(input.candidateId)
        ? {
            type: input.type,
            candidateId: input.candidateId,
          }
        : null;
    case "recover_approved_node":
    case "resume_approved_node_reconnect":
      return isNonEmptyString(input.ruleId)
        ? {
            type: input.type,
            ruleId: input.ruleId,
          }
        : null;
    case "e2e_step":
      return isNonEmptyString(input.name)
        ? {
            type: input.type,
            name: input.name as DesktopTestStepName,
            ...(input.payload !== undefined ? { payload: input.payload } : {}),
          }
        : null;
    default:
      return null;
  }
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
