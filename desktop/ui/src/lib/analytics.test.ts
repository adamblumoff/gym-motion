import { describe, expect, it } from "bun:test";

import type { MotionEventSummary } from "@core/contracts";

import { buildEventBuckets } from "./analytics";

function createEvent(id: number, deviceId: string): MotionEventSummary {
  return {
    id,
    deviceId,
    sequence: id,
    state: id % 2 === 0 ? "moving" : "still",
    delta: id * 2,
    eventTimestamp: 1_700_000_000 + id,
    receivedAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    bootId: null,
    firmwareVersion: "1.0.0",
    hardwareId: null,
  };
}

describe("analytics", () => {
  it("returns busiest devices first using real event counts", () => {
    const buckets = buildEventBuckets([
      createEvent(1, "stack-001"),
      createEvent(2, "stack-001"),
      createEvent(3, "stack-002"),
      createEvent(4, "stack-001"),
      createEvent(5, "stack-003"),
      createEvent(6, "stack-002"),
    ]);

    expect(buckets).toEqual([
      { deviceId: "stack-001", count: 3 },
      { deviceId: "stack-002", count: 2 },
      { deviceId: "stack-003", count: 1 },
    ]);
  });
});
