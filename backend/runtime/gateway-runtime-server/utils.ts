import path from "node:path";
import type {
  GatewayConnectionState,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";
import type { OtaRuntimeState, ReconnectRuntimeState } from "./runtime-types.js";

export const METADATA_REFRESH_MS = 15_000;
export const STREAM_PING_MS = 15_000;
export const TELEMETRY_FRESH_MS = 20_000;
export const RECONNECT_DISCONNECT_GRACE_MS = 1_000;
export const DEFAULT_KNOWN_NODE_DIR = path.join(process.cwd(), "data");

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseIsoTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function jsonResponse(
  response: { writeHead: (statusCode: number, headers: Record<string, string>) => void; end: (body: string) => void },
  statusCode: number,
  payload: unknown,
) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

export function formatSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function latestTimestamp(...timestamps: Array<string | null | undefined>): string | null {
  let latestValue = null;
  let latestTime = 0;

  for (const timestamp of timestamps) {
    const parsed = parseIsoTime(timestamp);

    if (parsed > latestTime) {
      latestTime = parsed;
      latestValue = timestamp;
    }
  }

  return latestValue;
}

export function telemetryFreshnessFromTimestamp(
  timestamp: string | null | undefined,
): GatewayRuntimeDeviceSummary["telemetryFreshness"] {
  if (!timestamp) {
    return "missing";
  }

  return Date.now() - parseIsoTime(timestamp) <= TELEMETRY_FRESH_MS ? "fresh" : "stale";
}

export function healthStatusFromRuntime(
  connectionState: GatewayConnectionState,
): GatewayRuntimeDeviceSummary["healthStatus"] {
  if (connectionState === "connected") {
    return "online";
  }

  if (
    connectionState === "connecting" ||
    connectionState === "reconnecting" ||
    connectionState === "discovered"
  ) {
    return "stale";
  }

  return "offline";
}

export function sortDevices(
  devices: GatewayRuntimeDeviceSummary[],
): GatewayRuntimeDeviceSummary[] {
  return devices.toSorted(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

export function emptyOtaRuntimeState(): OtaRuntimeState {
  return {
    otaStatus: "idle",
    otaTargetVersion: null,
    otaProgressBytesSent: null,
    otaTotalBytes: null,
    otaLastPhase: null,
    otaFailureDetail: null,
    otaLastStatusMessage: null,
    otaUpdatedAt: null,
  };
}

export function emptyReconnectRuntimeState(): ReconnectRuntimeState {
  return {
    reconnectAttempt: 0,
    reconnectAttemptLimit: 20,
    reconnectRetryExhausted: false,
    reconnectAwaitingDecision: false,
  };
}
