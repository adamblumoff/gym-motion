import type { GatewayRuntimeDeviceSummary } from "@core/contracts";

export function formatRelativeFromNow(value: string | null, now: number) {
  if (!value) {
    return "never";
  }

  const diffSeconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));

  if (diffSeconds < 5) {
    return "now";
  }

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  if (diffSeconds < 3600) {
    return `${Math.round(diffSeconds / 60)}m ago`;
  }

  return `${Math.round(diffSeconds / 3600)}h ago`;
}

export function formatDelta(value: number | null) {
  return value === null ? "--" : `${value}`;
}

export function formatRssi(value: number | null) {
  return value === null ? "RSSI unavailable" : `RSSI ${value}`;
}

export function summarizeDeviceSignal(device: GatewayRuntimeDeviceSummary) {
  if (device.lastRssi === null) {
    return "No signal";
  }

  if (device.lastRssi >= -55) {
    return "Strong";
  }

  if (device.lastRssi >= -72) {
    return "Stable";
  }

  return "Weak";
}
