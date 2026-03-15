export function isOperatorVisibleScan(
  scanState: string,
  scanReason: string | null | undefined,
) {
  return scanState === "scanning" && (scanReason === "manual" || scanReason == null);
}
