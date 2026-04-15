// @ts-nocheck
import path from "node:path";

function defaultSidecarPath() {
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
    runtimeHost: process.env.GATEWAY_RUNTIME_HOST ?? "127.0.0.1",
    runtimePort: Number(process.env.GATEWAY_RUNTIME_PORT ?? 4010),
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
