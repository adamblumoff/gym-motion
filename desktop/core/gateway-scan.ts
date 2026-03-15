export function isOperatorVisibleScan(
  scanState: string,
  scanReason: string | null | undefined,
) {
  return scanState === "scanning" && (scanReason === "manual" || scanReason == null);
}

export function liveStatusLabelForScan(
  scanState: string,
  scanReason: string | null | undefined,
  reconnectingNodeCount: number,
) {
  if (scanState !== "scanning") {
    return null;
  }

  if (reconnectingNodeCount > 0) {
    return "Reconnecting approved nodes";
  }

  if (isOperatorVisibleScan(scanState, scanReason)) {
    return "Scanning for BLE nodes";
  }

  return null;
}
