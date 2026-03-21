export async function flushBackgroundWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function createRuntimeServer(overrides = {}) {
  return {
    noteTelemetry(payload) {
      return Promise.resolve({
        before: { gatewayConnectionState: "connected" },
        after: {
          gatewayConnectionState: "connected",
          telemetryFreshness: "fresh",
          lastTelemetryAt: payload.timestamp,
          lastConnectedAt: null,
          lastDisconnectedAt: null,
        },
      });
    },
    resolveKnownDeviceId() {
      return null;
    },
    noteDiscovery() {},
    upsertManualScanCandidate() {},
    noteConnecting() {
      return {
        before: { gatewayConnectionState: "disconnected" },
        after: { gatewayConnectionState: "connecting" },
      };
    },
    noteConnected() {
      return {
        before: { gatewayConnectionState: "connecting" },
        after: {
          gatewayConnectionState: "connected",
          lastTelemetryAt: null,
          lastConnectedAt: null,
          lastDisconnectedAt: null,
        },
      };
    },
    noteDisconnected() {
      return {
        applied: true,
        before: { gatewayConnectionState: "connected", lastTelemetryAt: null },
        after: {
          gatewayConnectionState: "disconnected",
          lastTelemetryAt: null,
          lastConnectedAt: null,
          lastDisconnectedAt: null,
        },
      };
    },
    ...overrides,
  };
}
