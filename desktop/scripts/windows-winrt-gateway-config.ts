import path from "node:path";
import type { ApprovedNodeRule, BleAdapterSummary } from "@core/contracts";

type GatewayConfig = {
  runtimeHost: string;
  runtimePort: number;
  startScanOnBoot: boolean;
  sidecarPath: string;
  sidecarArgs: string[];
  verbose: boolean;
};

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

function parseSidecarArgs(raw: string | undefined) {
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

export function createGatewayConfig(): GatewayConfig {
  return {
    runtimeHost: process.env.GATEWAY_RUNTIME_HOST ?? "127.0.0.1",
    runtimePort: Number(process.env.GATEWAY_RUNTIME_PORT ?? 4010),
    startScanOnBoot: process.env.GATEWAY_START_SCAN_ON_BOOT === "1",
    sidecarPath: process.env.GATEWAY_SIDECAR_PATH ?? defaultSidecarPath(),
    sidecarArgs: parseSidecarArgs(process.env.GATEWAY_SIDECAR_ARGS_JSON),
    verbose: process.env.GATEWAY_VERBOSE === "1",
  };
}

export function parseApprovedNodeRules(raw: string | undefined): ApprovedNodeRule[] {
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

export function readSelectedAdapterId(value: string | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function selectPreferredAdapter(adapters: BleAdapterSummary[]) {
  return adapters.find((adapter) => adapter.isAvailable)?.id ?? adapters[0]?.id ?? null;
}
