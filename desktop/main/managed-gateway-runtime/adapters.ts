import type { BleAdapterSummary } from "@core/contracts";

export function applyAutoAdapterSelection(
  adapters: BleAdapterSummary[],
  usesWindowsNativeGateway: boolean,
) {
  if (usesWindowsNativeGateway) {
    return adapters.find((adapter) => adapter.isAvailable)?.id ?? adapters[0]?.id ?? null;
  }

  const usableAdapters = adapters.filter(
    (adapter) => adapter.isAvailable && adapter.runtimeDeviceId !== null,
  );

  if (usableAdapters.length === 1) {
    return usableAdapters[0].id;
  }

  return null;
}

export function deriveAdapterIssue(args: {
  adapters: BleAdapterSummary[];
  selectedAdapterId: string | null;
  usesWindowsNativeGateway: boolean;
  runtimeError?: string;
}) {
  const { adapters, selectedAdapterId, usesWindowsNativeGateway, runtimeError } = args;

  if (runtimeError) {
    return runtimeError;
  }

  if (adapters[0]?.id === "adapter-error") {
    return adapters[0].issue;
  }

  if (selectedAdapterId && !adapters.some((adapter) => adapter.id === selectedAdapterId)) {
    return "Bluetooth is unavailable on this machine.";
  }

  if (adapters.length === 0) {
    return usesWindowsNativeGateway
      ? "Bluetooth is unavailable on this machine."
      : "No compatible BLE adapters were detected.";
  }

  if (usesWindowsNativeGateway) {
    return null;
  }

  return selectedAdapterId ? null : "No compatible BLE adapters were detected.";
}
