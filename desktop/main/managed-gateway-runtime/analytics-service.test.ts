import { describe, expect, it } from "vitest";

import type { DeviceAnalyticsBucket, MotionEventSummary } from "@core/contracts";

import { summarizeMotionEventsInBuckets } from "./analytics-service";

function createBucket(startAt: string, endAt: string): DeviceAnalyticsBucket {
  return {
    key: startAt,
    label: startAt,
    startAt,
    endAt,
    movementCount: 0,
    movingSeconds: 0,
  };
}

function createMotionEvent(args: {
  id: number;
  state: MotionEventSummary["state"];
  receivedAt: string;
}): MotionEventSummary {
  return {
    id: args.id,
    deviceId: "stack-001",
    sequence: args.id,
    state: args.state,
    delta: null,
    eventTimestamp: Date.parse(args.receivedAt),
    receivedAt: args.receivedAt,
    bootId: "boot-1",
    firmwareVersion: "1.0.0",
    hardwareId: "hw-1",
  };
}

describe("summarizeMotionEventsInBuckets", () => {
  it("does not count an open moving segment toward moving time", () => {
    const buckets = [
      createBucket("2026-03-18T12:00:00.000Z", "2026-03-18T13:00:00.000Z"),
    ];

    const summary = summarizeMotionEventsInBuckets({
      buckets,
      bucketMs: 60 * 60 * 1000,
      windowStart: Date.parse("2026-03-18T12:00:00.000Z"),
      windowEnd: Date.parse("2026-03-18T13:00:00.000Z"),
      precedingState: "still",
      events: [
        createMotionEvent({
          id: 1,
          state: "moving",
          receivedAt: "2026-03-18T12:10:00.000Z",
        }),
      ],
    });

    expect(summary.totalMovementCount).toBe(1);
    expect(summary.totalMovingSeconds).toBe(0);
    expect(summary.buckets[0]).toMatchObject({
      movementCount: 1,
      movingSeconds: 0,
    });
  });

  it("commits moving duration once the interval closes", () => {
    const buckets = [
      createBucket("2026-03-18T12:00:00.000Z", "2026-03-18T13:00:00.000Z"),
    ];

    const summary = summarizeMotionEventsInBuckets({
      buckets,
      bucketMs: 60 * 60 * 1000,
      windowStart: Date.parse("2026-03-18T12:00:00.000Z"),
      windowEnd: Date.parse("2026-03-18T13:00:00.000Z"),
      precedingState: "still",
      events: [
        createMotionEvent({
          id: 1,
          state: "moving",
          receivedAt: "2026-03-18T12:10:00.000Z",
        }),
        createMotionEvent({
          id: 2,
          state: "still",
          receivedAt: "2026-03-18T12:25:00.000Z",
        }),
      ],
    });

    expect(summary.totalMovementCount).toBe(1);
    expect(summary.totalMovingSeconds).toBe(15 * 60);
    expect(summary.buckets[0]).toMatchObject({
      movementCount: 1,
      movingSeconds: 15 * 60,
    });
  });
});
