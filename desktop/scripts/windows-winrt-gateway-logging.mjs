export function shouldWriteDiscoveryLog(scanReason) {
  return scanReason !== "approved-reconnect";
}
