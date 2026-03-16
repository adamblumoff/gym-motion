export function shouldWriteDiscoveryLog(scanReason) {
  return scanReason !== "approved-reconnect";
}

export function shouldWriteSidecarLog(level, message, verbose) {
  if (level !== "info") {
    return true;
  }

  if (verbose) {
    return true;
  }

  return !(
    message.startsWith("Reconnect handshake step:") ||
    message.startsWith("Reconnect handshake GATT setup attempt ") ||
    message === "Pausing BLE scan while reconnect handshake is in flight."
  );
}
