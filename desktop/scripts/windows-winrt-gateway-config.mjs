import path from "node:path";
import process from "node:process";

export function createGatewayConfig() {
  return {
    apiBaseUrl: (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    runtimeHost: process.env.GATEWAY_RUNTIME_HOST ?? "127.0.0.1",
    runtimePort: Number(process.env.GATEWAY_RUNTIME_PORT ?? 4010),
    heartbeatMinIntervalMs: Number(process.env.GATEWAY_HEARTBEAT_DEDUPE_MS ?? 10_000),
    startScanOnBoot: process.env.GATEWAY_START_SCAN_ON_BOOT === "1",
    sidecarPath:
      process.env.GATEWAY_SIDECAR_PATH ??
      path.join(
        process.cwd(),
        "native",
        "windows-ble-sidecar",
        "target",
        "release",
        "gym-motion-ble-winrt.exe",
      ),
    verbose: process.env.GATEWAY_VERBOSE === "1",
  };
}

export function parseApprovedNodeRules(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readSelectedAdapterId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function selectPreferredAdapter(adapters) {
  return adapters.find((adapter) => adapter.isAvailable)?.id ?? adapters[0]?.id ?? null;
}
