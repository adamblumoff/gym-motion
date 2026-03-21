import { describe, expect, it } from "vitest";

import { createDataIngestController } from "./data-ingest";

describe("createDataIngestController", () => {
  it("preserves per-device order while allowing different devices to persist independently", async () => {
    const appliedEvents = [];
    const motionCalls = [];
    let releaseFirstDevice;

    const controller = createDataIngestController({
      applyDataEvent(event) {
        appliedEvents.push(event);
      },
      recordMotion(payload) {
        motionCalls.push(payload);

        if (payload.deviceId === "stack-001" && payload.sequence === 1) {
          return new Promise((resolve) => {
            releaseFirstDevice = () =>
              resolve({
                device: {
                  id: payload.deviceId,
                },
                event: {
                  id: 1,
                  deviceId: payload.deviceId,
                  sequence: payload.sequence ?? null,
                  state: payload.state,
                  delta: payload.delta ?? null,
                  eventTimestamp: payload.timestamp,
                  receivedAt: "2026-03-17T12:00:00.000Z",
                  bootId: payload.bootId ?? null,
                  firmwareVersion: payload.firmwareVersion ?? null,
                  hardwareId: payload.hardwareId ?? null,
                },
              });
          });
        }

        return Promise.resolve({
          device: {
            id: payload.deviceId,
          },
          event: {
            id: payload.sequence ?? 0,
            deviceId: payload.deviceId,
            sequence: payload.sequence ?? null,
            state: payload.state,
            delta: payload.delta ?? null,
            eventTimestamp: payload.timestamp,
            receivedAt: "2026-03-17T12:00:00.000Z",
            bootId: payload.bootId ?? null,
            firmwareVersion: payload.firmwareVersion ?? null,
            hardwareId: payload.hardwareId ?? null,
          },
        });
      },
    });

    const first = controller.handleMessage({
      messageId: "msg-1",
      type: "persist-motion",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "moving",
        timestamp: 1,
        sequence: 1,
      },
    });
    const second = controller.handleMessage({
      messageId: "msg-2",
      type: "persist-motion",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "still",
        timestamp: 2,
        sequence: 2,
      },
    });
    const third = controller.handleMessage({
      messageId: "msg-3",
      type: "persist-motion",
      deviceId: "stack-002",
      payload: {
        deviceId: "stack-002",
        state: "moving",
        timestamp: 3,
        sequence: 1,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(appliedEvents).toHaveLength(1);
    expect(appliedEvents[0]).toMatchObject({
      type: "motion-update",
      payload: {
        device: {
          id: "stack-002",
        },
      },
    });

    releaseFirstDevice?.();
    await Promise.all([first, second, third]);

    expect(motionCalls.map((payload) => `${payload.deviceId}:${payload.sequence}`)).toEqual([
      "stack-001:1",
      "stack-002:1",
      "stack-001:2",
    ]);
    expect(appliedEvents).toHaveLength(3);
    expect(appliedEvents[1]).toMatchObject({
      type: "motion-update",
      payload: {
        device: {
          id: "stack-001",
        },
        event: {
          sequence: 1,
        },
      },
    });
    expect(appliedEvents[2]).toMatchObject({
      type: "motion-update",
      payload: {
        device: {
          id: "stack-001",
        },
        event: {
          sequence: 2,
        },
      },
    });
  });

  it("serializes backfill behind earlier live writes for the same device", async () => {
    const callOrder: string[] = [];
    let releaseMotion: (() => void) | null = null;

    const controller = createDataIngestController({
      applyDataEvent() {},
      recordMotion(payload) {
        callOrder.push(`motion:${payload.sequence}`);
        return new Promise((resolve) => {
          releaseMotion = () =>
            resolve({
              device: { id: payload.deviceId },
              event: undefined,
            } as never);
        });
      },
      async recordBackfill(payload) {
        callOrder.push(`backfill:${payload.ackSequence}`);
        return {
          insertedEvents: [],
          insertedLogs: [],
          syncState: {
            deviceId: payload.deviceId,
            lastAckedSequence: payload.ackSequence,
            lastAckedBootId: payload.bootId ?? null,
            lastSyncCompletedAt: null,
            lastOverflowDetectedAt: null,
          },
          historySyncState: {
            deviceId: payload.deviceId,
            lastAckedHistorySequence: payload.ackSequence,
            lastHistorySyncCompletedAt: null,
            lastHistoryOverflowDetectedAt: null,
          },
        };
      },
    });

    const live = controller.handleMessage({
      messageId: "motion-1",
      type: "persist-motion",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        state: "moving",
        timestamp: 11,
        sequence: 11,
      },
    });
    const backfill = controller.handleMessage({
      messageId: "backfill-1",
      type: "persist-device-backfill",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        bootId: "boot-1",
        ackSequence: 10,
        records: [],
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder).toEqual(["motion:11"]);

    releaseMotion?.();
    await Promise.all([live, backfill]);

    expect(callOrder).toEqual(["motion:11", "backfill:10"]);
  });

  it("serializes heartbeat behind backfill for the same device while keeping other devices independent", async () => {
    const callOrder: string[] = [];
    let releaseBackfill: (() => void) | null = null;

    const controller = createDataIngestController({
      applyDataEvent() {},
      async recordMotion(payload) {
        callOrder.push(`motion:${payload.deviceId}:${payload.sequence}`);
        return {
          device: { id: payload.deviceId },
          event: undefined,
        } as never;
      },
      async recordHeartbeat(payload) {
        callOrder.push(`heartbeat:${payload.deviceId}:${payload.timestamp}`);
        return {
          device: { id: payload.deviceId },
        } as never;
      },
      recordBackfill(payload) {
        callOrder.push(`backfill:${payload.deviceId}:${payload.ackSequence}`);
        return new Promise((resolve) => {
          releaseBackfill = () =>
            resolve({
              insertedEvents: [],
              insertedLogs: [],
              syncState: {
                deviceId: payload.deviceId,
                lastAckedSequence: payload.ackSequence,
                lastAckedBootId: payload.bootId ?? null,
                lastSyncCompletedAt: null,
                lastOverflowDetectedAt: null,
              },
              historySyncState: {
                deviceId: payload.deviceId,
                lastAckedHistorySequence: payload.ackSequence,
                lastHistorySyncCompletedAt: null,
                lastHistoryOverflowDetectedAt: null,
              },
            });
        });
      },
    });

    const backfill = controller.handleMessage({
      messageId: "backfill-1",
      type: "persist-device-backfill",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        bootId: "boot-1",
        ackSequence: 10,
        records: [],
      },
    });
    const heartbeat = controller.handleMessage({
      messageId: "heartbeat-1",
      type: "persist-heartbeat",
      deviceId: "stack-001",
      payload: {
        deviceId: "stack-001",
        timestamp: 11,
        bootId: "boot-1",
        firmwareVersion: "0.5.3",
        hardwareId: "hw-1",
      },
    });
    const otherDeviceMotion = controller.handleMessage({
      messageId: "motion-1",
      type: "persist-motion",
      deviceId: "stack-002",
      payload: {
        deviceId: "stack-002",
        state: "moving",
        timestamp: 12,
        sequence: 1,
      },
    });

    await otherDeviceMotion;
    await Promise.resolve();
    await Promise.resolve();

    expect(callOrder).toEqual(["backfill:stack-001:10", "motion:stack-002:1"]);

    releaseBackfill?.();
    await Promise.all([backfill, heartbeat]);

    expect(callOrder).toEqual([
      "backfill:stack-001:10",
      "motion:stack-002:1",
      "heartbeat:stack-001:11",
    ]);
  });
});
