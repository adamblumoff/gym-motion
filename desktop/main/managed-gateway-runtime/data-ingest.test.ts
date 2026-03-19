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

  it("keeps live writes moving while backfill waits in its own lane", async () => {
    const callOrder: string[] = [];
    let releaseBackfill: (() => void) | null = null;

    const controller = createDataIngestController({
      applyDataEvent() {},
      async recordMotion(payload) {
        callOrder.push(`motion:${payload.sequence}`);
        return {
          device: { id: payload.deviceId },
          event: undefined,
        } as never;
      },
      recordBackfill(payload) {
        callOrder.push(`backfill:${payload.ackSequence}`);
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

    await live;
    expect(callOrder).toEqual(["backfill:10", "motion:11"]);

    releaseBackfill?.();
    await backfill;
  });
});
