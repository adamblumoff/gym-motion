import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeServer,
  flushBackgroundWork,
} from "./windows-winrt-gateway-runtime-bridge.test-support";
import { createRuntimeBridge } from "./windows-winrt-gateway-runtime-bridge";

afterEach(() => {
  vi.useRealTimers();
});

describe("windows winrt gateway runtime bridge", () => {
  it("serializes telemetry forwarding per device while allowing other devices to continue", async () => {
    const messages = [];
    let releaseFirstDevice;

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: createRuntimeServer({
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
      }),
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

    await flushBackgroundWork();

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
      runtimeServer: createRuntimeServer(),
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
      runtimeServer: createRuntimeServer(),
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

  it("only persists connected and disconnected lifecycle logs", async () => {
    const messages = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: createRuntimeServer({
        resolveKnownDeviceId(input) {
          if (input?.peripheralId === "AA:BB") {
            return "esp32-known";
          }

          return null;
        },
      }),
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

    await bridge.handleNodeConnectionState({
      gatewayConnectionState: "connecting",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    await bridge.handleNodeConnectionState({
      gatewayConnectionState: "connected",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    await bridge.handleNodeConnectionState({
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

  it("treats reconnecting transport events as connect-in-progress", async () => {
    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
      },
      runtimeServer: createRuntimeServer({
        resolveKnownDeviceId(input) {
          if (input?.peripheralId === "AA:BB") {
            return "esp32-known";
          }

          return null;
        },
      }),
      debug() {},
      sendToDesktop() {
        return true;
      },
    });

    bridge.handleNodeDiscovered({
      id: "candidate-1",
      peripheralId: "AA:BB",
      localName: "GymMotion-aabb",
    });

    await bridge.handleNodeConnectionState({
      gatewayConnectionState: "reconnecting",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });

    await bridge.handleNodeConnectionState({
      gatewayConnectionState: "connected",
      node: {
        peripheralId: "AA:BB",
        localName: "GymMotion-aabb",
      },
    });
  });

  it("waits for a stable live window before requesting history sync", async () => {
    vi.useFakeTimers();

    const sidecarCommands = [];
    const fetchCalls = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
        historySyncStabilityWindowMs: 5_000,
      },
      runtimeServer: createRuntimeServer({
        noteTelemetry() {
          return Promise.resolve({
            before: { gatewayConnectionState: "disconnected" },
            after: { gatewayConnectionState: "connected" },
          });
        },
      }),
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
              lastAckedSequence: 12,
              lastAckedBootId: "boot-1",
            },
            historySyncState: {
              deviceId: "stack-001",
              lastAckedHistorySequence: 12,
              lastHistorySyncCompletedAt: null,
              lastHistoryOverflowDetectedAt: null,
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

    await flushBackgroundWork();
    expect(fetchCalls).toEqual([]);
    expect(sidecarCommands).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushBackgroundWork();

    expect(fetchCalls).toEqual(["http://127.0.0.1:4111/api/device-sync/stack-001?bootId=boot-1"]);
    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 12,
        max_records: 256,
        request_id: expect.any(String),
      }),
    ]);
  });

  it("persists one history page and acks the repository-proven sequence", async () => {
    const sidecarCommands = [];
    const persistedBodies = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
        historySyncStabilityWindowMs: 0,
        historySyncInterPageDelayMs: 0,
      },
      runtimeServer: createRuntimeServer(),
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
              historySyncState: {
                deviceId: "stack-001",
                lastAckedHistorySequence: 4,
                lastHistorySyncCompletedAt: null,
                lastHistoryOverflowDetectedAt: null,
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
            historySyncState: {
              deviceId: "stack-001",
              lastAckedHistorySequence: 6,
              lastHistorySyncCompletedAt: null,
              lastHistoryOverflowDetectedAt: null,
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
    await flushBackgroundWork();
    const requestId = sidecarCommands[0]?.request_id;

    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
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
      request_id: requestId,
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
        request_id: requestId,
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
        syncComplete: true,
      },
    ]);
    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 4,
        max_records: 256,
        request_id: expect.any(String),
      }),
      expect.objectContaining({
        type: "acknowledge_history_sync",
        device_id: "stack-001",
        sequence: 6,
        request_id: requestId,
      }),
    ]);
  });

  it("requests the next page only after durable persist and ack", async () => {
    vi.useFakeTimers();

    const sidecarCommands = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
        historySyncStabilityWindowMs: 0,
        historySyncInterPageDelayMs: 1_000,
      },
      runtimeServer: createRuntimeServer(),
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
              historySyncState: {
                deviceId: "stack-001",
                lastAckedHistorySequence: 4,
                lastHistorySyncCompletedAt: null,
                lastHistoryOverflowDetectedAt: null,
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
            historySyncState: {
              deviceId: "stack-001",
              lastAckedHistorySequence: 6,
              lastHistorySyncCompletedAt: null,
              lastHistoryOverflowDetectedAt: null,
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
    await flushBackgroundWork();
    const requestId = sidecarCommands[0]?.request_id;

    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: { kind: "motion", sequence: 5, state: "moving", delta: 8, timestamp: 1 },
    });
    bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: { kind: "motion", sequence: 8, state: "still", delta: 0, timestamp: 2 },
    });

    await bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        request_id: requestId,
        latest_sequence: 8,
        high_water_sequence: 10,
        sent_count: 2,
        has_more: true,
        overflowed: false,
      },
    });

    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 4,
        max_records: 256,
        request_id: expect.any(String),
      }),
      expect.objectContaining({
        type: "acknowledge_history_sync",
        device_id: "stack-001",
        sequence: 6,
        request_id: requestId,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushBackgroundWork();

    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 4,
        max_records: 256,
        request_id: expect.any(String),
      }),
      expect.objectContaining({
        type: "acknowledge_history_sync",
        device_id: "stack-001",
        sequence: 6,
        request_id: requestId,
      }),
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 6,
        max_records: 256,
        request_id: expect.any(String),
      }),
    ]);
  });

  it("persists a completed page before processing a same-device disconnect that arrives right after it", async () => {
    const persistedBodies = [];
    const sidecarCommands = [];

    const bridge = createRuntimeBridge({
      config: {
        heartbeatMinIntervalMs: 10_000,
        desktopApiBaseUrl: "http://127.0.0.1:4111",
        historySyncStabilityWindowMs: 0,
        historySyncInterPageDelayMs: 0,
      },
      runtimeServer: createRuntimeServer({
        resolveKnownDeviceId() {
          return "stack-001";
        },
      }),
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
                lastAckedSequence: 0,
                lastAckedBootId: null,
              },
              historySyncState: {
                deviceId: "stack-001",
                lastAckedHistorySequence: 0,
                lastHistorySyncCompletedAt: null,
                lastHistoryOverflowDetectedAt: null,
              },
            }),
          });
        }

        persistedBodies.push(JSON.parse(init.body));
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            syncState: {
              deviceId: "stack-001",
              lastAckedSequence: 2,
              lastAckedBootId: "boot-1",
            },
            historySyncState: {
              deviceId: "stack-001",
              lastAckedHistorySequence: 2,
              lastHistorySyncCompletedAt: null,
              lastHistoryOverflowDetectedAt: null,
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
    await flushBackgroundWork();
    const requestId = sidecarCommands[0]?.request_id;

    const recordPromise = bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: { kind: "motion", sequence: 1, state: "moving", delta: 8, timestamp: 1 },
    });
    const secondRecordPromise = bridge.handleHistoryRecord({
      device_id: "stack-001",
      request_id: requestId,
      record: { kind: "motion", sequence: 2, state: "still", delta: 0, timestamp: 2 },
    });
    const completePromise = bridge.handleHistorySyncComplete({
      payload: {
        device_id: "stack-001",
        request_id: requestId,
        latest_sequence: 2,
        high_water_sequence: 2,
        sent_count: 2,
        has_more: false,
        overflowed: false,
      },
    });
    const disconnectPromise = bridge.handleNodeConnectionState({
      gatewayConnectionState: "disconnected",
      reason: "ble-disconnected",
      node: {
        knownDeviceId: "stack-001",
        peripheralId: "ble-001",
        localName: "GymMotion-f4e9d4",
      },
    });

    await Promise.all([
      recordPromise,
      secondRecordPromise,
      completePromise,
      disconnectPromise,
    ]);

    expect(persistedBodies).toEqual([
      {
        deviceId: "stack-001",
        records: [
          { kind: "motion", sequence: 1, state: "moving", delta: 8, timestamp: 1 },
          { kind: "motion", sequence: 2, state: "still", delta: 0, timestamp: 2 },
        ],
        ackSequence: 2,
        syncComplete: true,
      },
    ]);
    expect(sidecarCommands).toEqual([
      expect.objectContaining({
        type: "begin_history_sync",
        device_id: "stack-001",
        after_sequence: 0,
        max_records: 256,
        request_id: expect.any(String),
      }),
      expect.objectContaining({
        type: "acknowledge_history_sync",
        device_id: "stack-001",
        sequence: 2,
        request_id: requestId,
      }),
    ]);
  });

});
