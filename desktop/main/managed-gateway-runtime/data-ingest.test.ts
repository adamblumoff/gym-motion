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
});
