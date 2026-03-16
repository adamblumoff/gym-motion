export function describeNode(node = {}) {
  return {
    deviceId: node.knownDeviceId ?? node.known_device_id ?? null,
    knownDeviceId: node.knownDeviceId ?? node.known_device_id ?? null,
    peripheralId: node.peripheralId ?? node.peripheral_id ?? null,
    address: node.address ?? null,
    localName: node.localName ?? node.local_name ?? null,
    rssi: node.lastRssi ?? node.last_rssi ?? node.rssi ?? null,
  };
}

export function createDeviceContext(deviceId) {
  return {
    deviceId,
    lastState: null,
    lastHeartbeatForwardedAt: 0,
    firmwareVersion: "unknown",
    bootId: null,
    hardwareId: null,
    peripheralId: null,
    address: null,
    advertisedName: null,
    rssi: null,
    lastTelemetryConnectionState: null,
  };
}

export function normalizeAllowedNodesPayload(approvedNodeRules) {
  return approvedNodeRules.map((node) => ({
    id: node.id,
    label: node.label,
    peripheral_id: node.peripheralId ?? null,
    address: node.address ?? null,
    local_name: node.localName ?? null,
    known_device_id: node.knownDeviceId ?? null,
  }));
}
