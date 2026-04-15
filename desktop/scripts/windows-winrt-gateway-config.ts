// @ts-nocheck
import path from "node:path";
import process from "node:process";

function defaultSidecarPath() {
  if (
    process.env.GYM_MOTION_WINDOWS_BLE_BACKEND === "bridge" ||
    process.env.GYM_MOTION_USB_BLE_BRIDGE_PORT ||
    process.env.GYM_MOTION_USB_BLE_BRIDGE_SIMULATOR === "1"
  ) {
    return process.execPath;
  }

  if (process.env.GYM_MOTION_WINDOWS_SIDECAR_IMPL === "rust") {
    return path.join(
      process.cwd(),
      "native",
      "windows-ble-sidecar",
      "target",
      "release",
      "gym-motion-ble-winrt.exe",
    );
  }

  return path.join(
    process.cwd(),
    "native",
    "windows-dotnet-ble-sidecar",
    "bin",
    "Release",
    "net9.0-windows10.0.19041.0",
    "publish",
    "gym-motion-ble-winrt.exe",
  );
}

function parseSidecarArgs(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function createGatewayConfig() {
  return {
    apiBaseUrl: (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    desktopApiBaseUrl: (process.env.GATEWAY_DESKTOP_API_BASE_URL ?? "http://127.0.0.1:0").replace(
      /\/$/,
      "",
    ),
    runtimeHost: process.env.GATEWAY_RUNTIME_HOST ?? "127.0.0.1",
    runtimePort: Number(process.env.GATEWAY_RUNTIME_PORT ?? 4010),
    heartbeatMinIntervalMs: Number(process.env.GATEWAY_HEARTBEAT_DEDUPE_MS ?? 10_000),
    historySyncStabilityWindowMs: Number(
      process.env.GATEWAY_HISTORY_SYNC_STABILITY_MS ?? 5_000,
    ),
    historySyncPageSize: Number(process.env.GATEWAY_HISTORY_SYNC_PAGE_SIZE ?? 256),
    historySyncInterPageDelayMs: Number(
      process.env.GATEWAY_HISTORY_SYNC_INTER_PAGE_DELAY_MS ?? 0,
    ),
    startScanOnBoot: process.env.GATEWAY_START_SCAN_ON_BOOT === "1",
    sidecarPath: process.env.GATEWAY_SIDECAR_PATH ?? defaultSidecarPath(),
    sidecarArgs: parseSidecarArgs(process.env.GATEWAY_SIDECAR_ARGS_JSON),
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
