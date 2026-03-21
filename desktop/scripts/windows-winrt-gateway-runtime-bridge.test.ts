import { describe, expect, it } from "vitest";

import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge";

describe("windows winrt gateway runtime bridge", () => {
  it("serializes telemetry forwarding per device while allowing other devices to continue", async () => {
    const messages = [];
    let releaseFirstDevice;

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: {
        noteTelemetry(payload) {
          if (payload.deviceId === "stack-001" && payload.sequence === 1) {
            return new Promise((resolve) => {
              releaseFirstDevice = () =>
                resolve({
                  before: { gatewayConnectionState: "connected" },
                  after: {
                    gatewayConnectionState: "connected",
                    telemetryFreshness: "fresh",
                    lastTelemetryAt: payload.timestamp,
                    lastConnectedAt: null,
                    lastDisconnectedAt: null,
                  },
                });
            });
          }

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
      },
      debug() {},
      sendToDesktop(message) {
        messages.push(message);
        return true;
      },
    });

    const firstForward = bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 12,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.1",
      hardwareId: "hw-1",
    });
    const secondForward = bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "still",
      timestamp: 2,
      delta: 0,
      sequence: 2,
      bootId: "boot-1",
      firmwareVersion: "0.5.1",
      hardwareId: "hw-1",
    });
    const thirdForward = bridge.forwardTelemetry({
      deviceId: "stack-002",
      state: "moving",
      timestamp: 3,
      delta: 9,
      sequence: 1,
      bootId: "boot-2",
      firmwareVersion: "0.5.1",
      hardwareId: "hw-2",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(messages).toEqual([
      {
        type: "persist-motion",
        deviceId: "stack-002",
        payload: {
          deviceId: "stack-002",
          state: "moving",
          timestamp: 3,
          delta: 9,
          sequence: 1,
          bootId: "boot-2",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-2",
        },
      },
    ]);

    releaseFirstDevice?.();
    await Promise.all([firstForward, secondForward, thirdForward]);

    expect(messages).toEqual([
      {
        type: "persist-motion",
        deviceId: "stack-002",
        payload: {
          deviceId: "stack-002",
          state: "moving",
          timestamp: 3,
          delta: 9,
          sequence: 1,
          bootId: "boot-2",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-2",
        },
      },
      {
        type: "persist-motion",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          state: "moving",
          timestamp: 1,
          delta: 12,
          sequence: 1,
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      },
      {
        type: "persist-motion",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          state: "still",
          timestamp: 2,
          delta: 0,
          sequence: 2,
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      },
    ]);
  });

  it("keeps raw sidecar logs console-only", () => {
    const messages = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop(message) {
        messages.push(message);
        return true;
      },
    });

    expect(bridge).not.toHaveProperty("handleSidecarLog");
    expect(messages).toEqual([]);
  });

  it("persists snapshot telemetry as a heartbeat even when it seeds the current state", async () => {
    const messages = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: {
              gatewayConnectionState: "connected",
              telemetryFreshness: "fresh",
              lastTelemetryAt: 1,
              lastConnectedAt: null,
              lastDisconnectedAt: null,
            },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop(message) {
        messages.push(message);
        return true;
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "still",
      timestamp: 1,
      delta: 0,
      sequence: 99,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
      snapshot: true,
    });

    expect(messages).toEqual([
      {
        type: "persist-heartbeat",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          timestamp: 1,
          bootId: "boot-1",
          firmwareVersion: "0.5.3",
          hardwareId: "hw-1",
        },
      },
    ]);
  });

  it("only persists connected and disconnected lifecycle logs", () => {
    const messages = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId(input) {
          if (input?.peripheralId === "AA:BB") {
            return "esp32-known";
          }

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
      },
      debug() {},
      sendToDesktop(message) {
        messages.push(message);
        return true;
      },
    });

    bridge.handleNodeDiscovered({
      id: "candidate-1",
      peripheralId: "AA:BB",
      localName: "GymMotion-aabb",
    });

    bridge.handleNodeConnectionState({
      gatewayConnectionState: "connecting",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    bridge.handleNodeConnectionState({
      gatewayConnectionState: "connected",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    bridge.handleNodeConnectionState({
      gatewayConnectionState: "disconnected",
      reason: "ble-disconnected",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    expect(messages).toEqual([
      {
        type: "persist-device-log",
        deviceId: "esp32-known",
        payload: {
          deviceId: "esp32-known",
          level: "info",
          code: "node.connected",
          message: "Gateway connected to GymMotion-aabb.",
          bootId: undefined,
          firmwareVersion: undefined,
          hardwareId: undefined,
          metadata: {
            peripheralId: "AA:BB",
            address: null,
            reconnectAttempt: null,
            reconnectAttemptLimit: null,
            transportStateBefore: "connecting",
            transportStateAfter: "connected",
            lastTelemetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
          },
        },
      },
      {
        type: "persist-device-log",
        deviceId: "esp32-known",
        payload: {
          deviceId: "esp32-known",
          level: "warn",
          code: "node.disconnected",
          message: "Gateway lost GymMotion-aabb.",
          bootId: undefined,
          firmwareVersion: undefined,
          hardwareId: undefined,
          metadata: {
            peripheralId: "AA:BB",
            address: null,
            reason: "ble-disconnected",
            reconnectAttempt: null,
            reconnectAttemptLimit: null,
            reconnectRetryExhausted: null,
            reconnectAwaitingDecision: null,
            transportStateBefore: "connected",
            transportStateAfter: "disconnected",
            lastTelemetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
          },
        },
      },
    ]);
  });

  it("requests history sync from the stored ack sequence for the current boot", async () => {
    const sidecarCommands = [];
    const fetchCalls = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl(url) {
        fetchCalls.push(url);
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: {
              deviceId: "stack-001",
              lastAckedSequence: 12,
              lastAckedBootId: "boot-1",
            },
          }),
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 13,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    expect(fetchCalls).toEqual(["http://127.0.0.1:4111/api/device-sync/stack-001?bootId=boot-1"]);
    expect(sidecarCommands[0]).toEqual({
      type: "begin_history_sync",
      device_id: "stack-001",
      after_sequence: 12,
      max_records: 0,
    });
  });

  it("requests history sync from zero for a new boot", async () => {
    const sidecarCommands = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl() {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: {
              deviceId: "stack-001",
              lastAckedSequence: 0,
              lastAckedBootId: null,
            },
          }),
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 1,
      bootId: "boot-2",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    expect(sidecarCommands[0]).toEqual({
      type: "begin_history_sync",
      device_id: "stack-001",
      after_sequence: 0,
      max_records: 0,
    });
  });

  it("persists a history page and acks the repository-proven sequence", async () => {
    const sidecarCommands = [];
    const persistedBodies = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl(url, init) {
        if (String(url).includes("/api/device-sync/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              syncState: {
                deviceId: "stack-001",
                lastAckedSequence: 4,
                lastAckedBootId: "boot-1",
              },
            }),
          });
        }

        persistedBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: {
              deviceId: "stack-001",
              lastAckedSequence: 6,
              lastAckedBootId: "boot-1",
            },
          }),
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 5,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    bridge.handleHistoryRecord({
      device_id: "stack-001",
      record: {
        kind: "motion",
        sequence: 5,
        state: "moving",
        delta: 8,
        timestamp: 1,
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    });
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      record: {
        kind: "node-log",
        sequence: 6,
        level: "info",
        code: "node.connected",
        message: "Connected",
        timestamp: 2,
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    });

    await bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        latest_sequence: 6,
        high_water_sequence: 6,
        sent_count: 2,
        has_more: false,
        overflowed: false,
      },
    });

    expect(persistedBodies).toEqual([
      {
        deviceId: "stack-001",
        bootId: "boot-1",
        records: [
          {
            kind: "motion",
            sequence: 5,
            state: "moving",
            delta: 8,
            timestamp: 1,
            bootId: "boot-1",
            firmwareVersion: "0.5.3",
            hardwareId: "hw-1",
          },
          {
            kind: "node-log",
            sequence: 6,
            level: "info",
            code: "node.connected",
            message: "Connected",
            timestamp: 2,
            bootId: "boot-1",
            firmwareVersion: "0.5.3",
            hardwareId: "hw-1",
          },
        ],
        ackSequence: 6,
      },
    ]);
    expect(sidecarCommands).toEqual([
      {
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 4,
        max_records: 0,
      },
      {
        type: "acknowledge_history_sync",
        device_id: "stack-001",
        sequence: 6,
      },
    ]);
  });

  it("requests the next history page from the repository-proven ack sequence", async () => {
    const sidecarCommands = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl(url) {
        if (String(url).includes("/api/device-sync/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              syncState: {
                deviceId: "stack-001",
                lastAckedSequence: 4,
                lastAckedBootId: "boot-1",
              },
            }),
          });
        }

        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: {
              deviceId: "stack-001",
              lastAckedSequence: 6,
              lastAckedBootId: "boot-1",
            },
          }),
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 5,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    bridge.handleHistoryRecord({
      device_id: "stack-001",
      record: {
        kind: "motion",
        sequence: 5,
        state: "moving",
        delta: 8,
        timestamp: 1,
      },
    });
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      record: {
        kind: "motion",
        sequence: 8,
        state: "still",
        delta: 0,
        timestamp: 2,
      },
    });

    await bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        latest_sequence: 8,
        high_water_sequence: 10,
        sent_count: 2,
        has_more: true,
        overflowed: false,
      },
    });

    expect(sidecarCommands).toEqual([
      {
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 4,
        max_records: 0,
      },
      {
        type: "acknowledge_history_sync",
        device_id: "stack-001",
        sequence: 6,
      },
      {
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 6,
        max_records: 0,
      },
    ]);
  });

  it("does not persist or ack an empty history sync completion", async () => {
    const sidecarCommands = [];
    const fetchCalls = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl(url) {
        fetchCalls.push(String(url));
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: {
              deviceId: "stack-001",
              lastAckedSequence: 0,
              lastAckedBootId: null,
            },
          }),
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    await bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        latest_sequence: 0,
        high_water_sequence: 0,
        sent_count: 0,
        has_more: false,
        overflowed: false,
      },
    });

    expect(fetchCalls).toEqual(["http://127.0.0.1:4111/api/device-sync/stack-001?bootId=boot-1"]);
    expect(sidecarCommands).toEqual([
      {
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 0,
        max_records: 0,
      },
    ]);
  });

  it("does not ack history when persistence fails", async () => {
    const sidecarCommands = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
      },
      runtimeServer: {
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "connected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
        resolveKnownDeviceId() {
          return null;
        },
      },
      debug() {},
      sendToDesktop() {
        return true;
      },
      sendSidecarCommand(command) {
        sidecarCommands.push(command);
        return Promise.resolve();
      },
      fetchImpl(url) {
        if (String(url).includes("/api/device-sync/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              syncState: {
                deviceId: "stack-001",
                lastAckedSequence: 0,
                lastAckedBootId: null,
              },
            }),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 500,
        });
      },
    });

    await bridge.forwardTelemetry({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1,
      delta: 8,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    bridge.handleHistoryRecord({
      device_id: "stack-001",
      record: {
        kind: "motion",
        sequence: 1,
        state: "moving",
        delta: 8,
        timestamp: 1,
      },
    });

    await bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        latest_sequence: 1,
        high_water_sequence: 1,
        sent_count: 1,
        has_more: false,
        overflowed: false,
      },
    });

    expect(sidecarCommands).toEqual([
      {
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 0,
        max_records: 0,
      },
    ]);
  });
});
