// @ts-nocheck
export function shouldWriteGatewayLog(message, verbose) {
  if (verbose) {
    return true;
  }

  return (
    message === "Windows BLE sidecar is ready." ||
    message === "received node connection state"
  );
}

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

  return (
    message.startsWith("Configured telemetry notifications.") ||
    message.startsWith("Established session via direct runtime-status verification.")
  );
}
