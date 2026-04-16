import type {
  BleAdapterSummary,
  GatewayConnectionState,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  ManualScanCandidateSummary,
  MotionState,
} from "@core/contracts";
import type {
  DiscoveryLocator,
  RuntimeDeviceEventPayload,
  RuntimeGatewayConnectionEvent,
  TelemetryPayload,
  TelemetryPeripheralInfo,
} from "../../backend/runtime/gateway-runtime-server/runtime-types.js";

export type GatewayLogFn = (message: string, details?: unknown) => void;

export type GatewayNodeRecord = {
  knownDeviceId?: string | null;
  known_device_id?: string | null;
  peripheralId?: string | null;
  peripheral_id?: string | null;
  address?: string | null;
  localName?: string | null;
  local_name?: string | null;
  lastRssi?: number | null;
  last_rssi?: number | null;
  rssi?: number | null;
};

export type GatewayDeviceContext = {
  deviceId: string;
  lastState: MotionState | null;
  firmwareVersion: string;
  bootId: string | null;
  hardwareId: string | null;
  peripheralId: string | null;
  address: string | null;
  advertisedName: string | null;
  rssi: number | null;
};

export type GatewayTelemetryEvent = {
  payload_text?: string | null;
  payloadText?: string | null;
  node?: GatewayNodeRecord | null;
};

export type GatewayConnectionStateEvent = {
  gateway_connection_state?: GatewayConnectionState;
  gatewayConnectionState?: GatewayConnectionState;
  node?: GatewayNodeRecord | null;
  reason?: string | null;
};

export type GatewayPersistMessageType =
  | "persist-motion"
  | "persist-heartbeat"
  | "persist-device-log";

export type GatewayPersistMessage = {
  type: GatewayPersistMessageType;
  deviceId: string;
  payload: unknown;
  messageId?: string;
};

export type GatewayPersistAckMessage = {
  type: "persist-ack";
  messageId: string;
  ok: boolean;
  error?: string;
};

export type GatewayDesktopMessage =
  | GatewayPersistMessage
  | GatewayPersistAckMessage
  | {
      type: "gateway-state";
      gateway: GatewayStatusSummary;
      issue: string | null;
    }
  | {
      type: "adapters-updated";
      adapters: BleAdapterSummary[];
      issue: string | null;
    }
  | {
      type: "runtime-device-updated";
      device: GatewayRuntimeDeviceSummary;
    }
  | {
      type: "manual-scan-updated";
      payload: {
        state?: "idle" | "scanning" | "pairing" | "failed";
        pairingCandidateId?: string | null;
        error?: string | null;
        candidates?: ManualScanCandidateSummary[];
      };
    }
  | {
      type: "runtime-ready";
      gateway: GatewayStatusSummary;
      issue: string | null;
      adapters: BleAdapterSummary[];
      manualScan: {
        state?: "idle" | "scanning" | "pairing" | "failed";
        pairingCandidateId?: string | null;
        error?: string | null;
        candidates?: ManualScanCandidateSummary[];
      };
    }
  | {
      type: "control-response";
      commandId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    };

export type GatewaySidecarAdapterRecord = {
  id: string;
  label: string;
  transport?: BleAdapterSummary["transport"] | null;
  is_available?: boolean;
  isAvailable?: boolean;
  issue?: string | null;
  details?: unknown;
};

export type GatewaySidecarEvent = {
  type: string;
  adapters?: GatewaySidecarAdapterRecord[] | null;
  gateway?: {
    adapter_state?: string | null;
    scan_state?: string | null;
    scan_reason?: string | null;
    issue?: string | null;
  } | null;
  adapterState?: string | null;
  scanState?: string | null;
  scanReason?: string | null;
  issue?: string | null;
  node?: GatewayNodeRecord | null;
  level?: string | null;
  message?: string | null;
  details?: unknown;
  payload_text?: string | null;
  payloadText?: string | null;
};

export type GatewayRuntimeServer = {
  getGatewayState: () => GatewayStatusSummary;
  getAvailableAdapters: () => BleAdapterSummary[];
  getDeviceSummary: (deviceId: string | null | undefined) => GatewayRuntimeDeviceSummary | null;
  getDeviceSummaries: () => GatewayRuntimeDeviceSummary[];
  getManualScanPayload: () => {
    state?: string;
    pairingCandidateId?: string | null;
    error?: string | null;
    candidates?: ManualScanCandidateSummary[];
  };
  setGatewayIssue: (issue: string | null) => void;
  setAvailableAdapters: (adapters: BleAdapterSummary[]) => void;
  setAdapterState: (state: string) => void;
  setScanState: (scanState: string, scanReason?: string | null) => void;
  noteDiscovery: (payload: RuntimeDeviceEventPayload) => unknown;
  noteTelemetry: (
    payload: TelemetryPayload,
    peripheralInfo?: TelemetryPeripheralInfo,
  ) => Promise<unknown>;
  resolveKnownDeviceId: (input: DiscoveryLocator) => string | null;
  applyGatewayConnectionState: (event: RuntimeGatewayConnectionEvent) => unknown;
  restoreApprovedDevice: (input: DiscoveryLocator) => unknown;
  forgetDevice: (input: DiscoveryLocator) => unknown;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
