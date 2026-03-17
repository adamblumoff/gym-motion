import { describe, expect, it } from "bun:test";

import { createHistorySyncCoordinator } from "./windows-winrt-gateway-history-sync.mjs";

describe("windows winrt gateway history sync", () => {
  it("persists a completed history page before acking firmware and requesting the next page", async () => {
    const commands = [];
    const persisted = [];
    const states = [];

    const coordinator = createHistorySyncCoordinator({
      sendSidecarCommand(type, payload) {
        commands.push({ type, payload });
      },
      sendRequestToDesktop(message) {
        persisted.push(message);
        return Promise.resolve();
      },
      onHistorySyncStateChanged(update) {
        states.push(update);
      },
      debug() {},
      pageSize: 2,
      autoStartDelayMs: 0,
    });

    coordinator.handleNodeConnected({
      id: "candidate-1",
      peripheralId: "peripheral:abc",
      knownDeviceId: "stack-001",
    });

    coordinator.handleHistoryRecord({
      node: { peripheralId: "peripheral:abc" },
      deviceId: "stack-001",
      record: {
        kind: "motion",
        sequence: 1,
        state: "moving",
        timestamp: 1000,
        delta: 12,
        bootId: "boot-1",
      },
    });
    coordinator.handleHistoryRecord({
      node: { peripheralId: "peripheral:abc" },
      deviceId: "stack-001",
      record: {
        kind: "motion",
        sequence: 2,
        state: "still",
        timestamp: 2000,
        delta: 0,
        bootId: "boot-1",
      },
    });

    await coordinator.handleHistorySyncComplete({
      node: { peripheralId: "peripheral:abc" },
      payload: {
        deviceId: "stack-001",
        latestSequence: 2,
        highWaterSequence: 4,
        sentCount: 2,
        hasMore: true,
      },
    });

    expect(persisted).toEqual([
      {
        type: "persist-device-backfill",
        deviceId: "stack-001",
        payload: {
          deviceId: "stack-001",
          bootId: "boot-1",
          records: [
            {
              kind: "motion",
              sequence: 1,
              state: "moving",
              delta: 12,
              timestamp: 1000,
              bootId: "boot-1",
              firmwareVersion: undefined,
              hardwareId: undefined,
            },
            {
              kind: "motion",
              sequence: 2,
              state: "still",
              delta: 0,
              timestamp: 2000,
              bootId: "boot-1",
              firmwareVersion: undefined,
              hardwareId: undefined,
            },
          ],
          ackSequence: 2,
          overflowDetectedAt: undefined,
        },
      },
    ]);
    expect(commands).toEqual([
      {
        type: "start_history_sync",
        payload: {
          connection_id: "peripheral:abc",
          after_sequence: 0,
          max_records: 2,
        },
      },
      {
        type: "ack_history_sync",
        payload: {
          connection_id: "peripheral:abc",
          sequence: 2,
          max_records: 2,
          continue_after_sequence: 2,
        },
      },
    ]);
    expect(states).toEqual([
      {
        deviceId: "stack-001",
        knownDeviceId: "stack-001",
        peripheralId: "peripheral:abc",
        address: null,
        localName: null,
        state: "syncing",
        error: null,
      },
      {
        deviceId: "stack-001",
        knownDeviceId: "stack-001",
        peripheralId: "peripheral:abc",
        address: null,
        localName: null,
        state: "syncing",
        error: null,
      },
    ]);
  });

  it("stores overflow-only sync pages without acking nonexistent records", async () => {
    const commands = [];
    const persisted = [];

    const coordinator = createHistorySyncCoordinator({
      sendSidecarCommand(type, payload) {
        commands.push({ type, payload });
      },
      sendRequestToDesktop(message) {
        persisted.push(message);
        return Promise.resolve();
      },
      debug() {},
      autoStartDelayMs: 0,
    });

    coordinator.handleNodeConnected({
      id: "candidate-1",
      peripheralId: "peripheral:def",
      knownDeviceId: "stack-002",
    });

    await coordinator.handleHistorySyncComplete({
      node: { peripheralId: "peripheral:def" },
      payload: {
        deviceId: "stack-002",
        latestSequence: 0,
        highWaterSequence: 0,
        sentCount: 0,
        hasMore: false,
        overflowed: true,
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0].type).toBe("persist-device-backfill");
    expect(persisted[0].payload.records).toEqual([]);
    expect(typeof persisted[0].payload.overflowDetectedAt).toBe("string");
    expect(commands).toEqual([
      {
        type: "start_history_sync",
        payload: {
          connection_id: "peripheral:def",
          after_sequence: 0,
          max_records: 250,
        },
      },
    ]);
  });

  it("surfaces history replay failures without tearing down the session state", () => {
    const states = [];

    const coordinator = createHistorySyncCoordinator({
      sendSidecarCommand() {},
      sendRequestToDesktop() {
        return Promise.resolve();
      },
      onHistorySyncStateChanged(update) {
        states.push(update);
      },
      debug() {},
      autoStartDelayMs: 0,
    });

    coordinator.handleNodeConnected({
      peripheralId: "peripheral:ghi",
      knownDeviceId: "stack-003",
      localName: "GymMotion-003",
    });

    coordinator.handleRuntimeLog({
      level: "warn",
      message:
        "History replay start failed and control-path recovery did not succeed; forcing a clean reconnect.",
      details: {
        peripheralId: "peripheral:ghi",
        knownDeviceId: "stack-003",
        error: "The object has been closed.",
      },
    });

    expect(states).toEqual([
      {
        deviceId: "stack-003",
        knownDeviceId: "stack-003",
        peripheralId: "peripheral:ghi",
        address: null,
        localName: "GymMotion-003",
        state: "syncing",
        error: null,
      },
      {
        deviceId: "stack-003",
        knownDeviceId: "stack-003",
        peripheralId: "peripheral:ghi",
        address: null,
        localName: "GymMotion-003",
        state: "failed",
        error:
          "History replay start failed and control-path recovery did not succeed; forcing a clean reconnect. The object has been closed.",
      },
    ]);
  });

  it("delays automatic history replay until after the configured post-connect delay", () => {
    const commands = [];
    const scheduled = [];
    const cleared = [];

    const coordinator = createHistorySyncCoordinator({
      sendSidecarCommand(type, payload) {
        commands.push({ type, payload });
      },
      sendRequestToDesktop() {
        return Promise.resolve();
      },
      debug() {},
      autoStartDelayMs: 5_000,
      scheduleAutoStart(callback, delayMs) {
        const token = { callback, delayMs };
        scheduled.push(token);
        return token;
      },
      clearScheduledAutoStart(token) {
        cleared.push(token);
      },
    });

    coordinator.handleNodeConnected({
      peripheralId: "peripheral:jkl",
      knownDeviceId: "stack-004",
      localName: "GymMotion-004",
    });

    expect(commands).toEqual([]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(5_000);

    scheduled[0].callback();

    expect(commands).toEqual([
      {
        type: "start_history_sync",
        payload: {
          connection_id: "peripheral:jkl",
          after_sequence: 0,
          max_records: 250,
        },
      },
    ]);
    expect(cleared).toEqual([]);
  });
});
