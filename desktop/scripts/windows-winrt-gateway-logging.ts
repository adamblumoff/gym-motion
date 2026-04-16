export function shouldWriteGatewayLog(message: string, verbose: boolean) {
  if (verbose) {
    return true;
  }

  return (
    message === "Windows BLE sidecar is ready." ||
    message === "received node connection state"
  );
}

export function shouldWriteDiscoveryLog(scanReason: string | null) {
  return scanReason !== "approved-reconnect";
}

export function shouldWriteSidecarLog(level: string, message: string, verbose: boolean) {
  if (level !== "info") {
    return true;
  }

  if (verbose) {
    return true;
  }

  return (
    message.startsWith("Configured telemetry notifications.") ||
    message.startsWith("Established session via direct runtime-status verification.") ||
    message.startsWith("Pausing BLE scan while reconnect handshake is in flight.")
  );
}
