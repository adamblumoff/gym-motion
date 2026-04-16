import type {
  DeviceSummary,
  GatewayConnectionState,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  MotionState,
  OtaRuntimeStatus,
  TelemetryFreshness,
  IngestPayload,
} from "@core/contracts";

export type RuntimeDeviceMetadata = DeviceSummary;

export type OtaRuntimeState = {
  otaStatus: OtaRuntimeStatus;
  otaTargetVersion: string | null;
  otaProgressBytesSent: number | null;
  otaTotalBytes: number | null;
  otaLastPhase: string | null;
  otaFailureDetail: string | null;
  otaLastStatusMessage: string | null;
  otaUpdatedAt: string | null;
};

export type ReconnectRuntimeState = {
  reconnectAttempt: number;
  reconnectAttemptLimit: number;
  reconnectRetryExhausted: boolean;
  reconnectAwaitingDecision: boolean;
};

export type RuntimeNode = OtaRuntimeState &
  ReconnectRuntimeState & {
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
    lastState: MotionState;
    sensorIssue: string | null;
    lastSeenAt: number;
    lastDelta: number | null;
    firmwareVersion: string;
    bootId: string | null;
    hardwareId: string | null;
    updatedAt: string;
  };

export type RuntimeNodePatch = Partial<RuntimeNode>;

export type KnownNode = {
  deviceId: string;
  peripheralId?: string | null;
  lastAdvertisedName?: string | null;
  lastKnownAddress?: string | null;
  lastSeenAt?: string | null;
  lastConnectedAt?: string | null;
  machineLabel?: string | null;
  siteId?: string | null;
  firmwareVersion?: string;
  hardwareId?: string | null;
};

export type DiscoveryLocator = {
  deviceId?: string | null;
  knownDeviceId?: string | null;
  peripheralId?: string | null;
  localName?: string | null;
  address?: string | null;
};

export type DiscoveryUpsertPayload = {
  peripheralId?: string | null;
  address?: string | null;
  localName?: string | null;
  rssi?: number | null;
  knownDeviceId?: string | null;
};

export type RuntimeDeviceEventPayload = DiscoveryLocator & {
  rssi?: number | null;
  reconnectAttempt?: number | null;
  reconnectAttemptLimit?: number | null;
  reconnectRetryExhausted?: boolean | null;
  reconnectAwaitingDecision?: boolean | null;
};

export type RuntimeGatewayTransitionState =
  | "connecting"
  | "reconnecting"
  | "connected"
  | "disconnected";

export type RuntimeGatewayConnectionEvent = RuntimeDeviceEventPayload & {
  connectionState: RuntimeGatewayTransitionState;
  reason?: string | null;
};

export type TelemetryPeripheralInfo = {
  peripheralId?: string | null;
  address?: string | null;
  localName?: string | null;
  rssi?: number | null;
};

export type TelemetryPayload = IngestPayload;

export type NodeConnectionInspection = {
  deviceId: string;
  gatewayConnectionState: GatewayConnectionState;
  telemetryFreshness: TelemetryFreshness;
  lastTelemetryAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  disconnectReason: string | null;
};

export type KnownNodeStore = {
  loadKnownNodes: () => Promise<void>;
  persistKnownNodes: () => Promise<unknown>;
  schedulePersist: () => void;
  cancelPersist: () => void;
};

export type TouchGatewayState = (patch?: Partial<GatewayStatusSummary>) => void;
export type EmitDevice = (deviceId: string) => void;
export type MergeDevice = (deviceId: string) => GatewayRuntimeDeviceSummary;

