import { describe, expect, it } from "bun:test";

import { buildMovementAnalyticsFromEvents } from "../../backend/data/repository/movement-analytics";

describe("buildMovementAnalyticsFromEvents", () => {
  it("counts movement starts in the bucket where motion begins", () => {
    const analytics = buildMovementAnalyticsFromEvents({
      deviceId: "stack-001",
      range: "24h",
      rangeStartAt: new Date("2026-03-17T10:00:00.000Z"),
      rangeEndAt: new Date("2026-03-17T11:00:00.000Z"),
      precedingEvent: null,
      events: [
        {
          state: "moving",
          receivedAt: new Date("2026-03-17T10:05:00.000Z"),
        },
        {
          state: "still",
          receivedAt: new Date("2026-03-17T10:20:00.000Z"),
        },
      ],
      hasOlderHistory: false,
      lastCanonicalEventAt: "2026-03-17T10:20:00.000Z",
      compactionNotice: null,
      timezone: "UTC",
      computedAt: new Date("2026-03-17T11:00:00.000Z"),
    });

    const activeBucket = analytics.buckets.find(
      (bucket) => bucket.bucketStartAt === "2026-03-17T10:00:00.000Z",
    );

    expect(activeBucket?.movementCount).toBe(1);
    expect(activeBucket?.movementDurationMs).toBe(10 * 60 * 1000);
  });

  it("carries a moving state from before the range into the first bucket", () => {
    const analytics = buildMovementAnalyticsFromEvents({
      deviceId: "stack-001",
      range: "24h",
      rangeStartAt: new Date("2026-03-17T10:00:00.000Z"),
      rangeEndAt: new Date("2026-03-17T11:00:00.000Z"),
      precedingEvent: {
        state: "moving",
        receivedAt: new Date("2026-03-17T09:55:00.000Z"),
      },
      events: [
        {
          state: "still",
          receivedAt: new Date("2026-03-17T10:10:00.000Z"),
        },
      ],
      hasOlderHistory: true,
      lastCanonicalEventAt: "2026-03-17T10:10:00.000Z",
      compactionNotice: null,
      timezone: "UTC",
      computedAt: new Date("2026-03-17T11:00:00.000Z"),
    });

    const firstBucket = analytics.buckets.find(
      (bucket) => bucket.bucketStartAt === "2026-03-17T10:00:00.000Z",
    );

    expect(firstBucket?.movementCount).toBe(0);
    expect(firstBucket?.movementDurationMs).toBe(10 * 60 * 1000);
    expect(analytics.hasOlderHistory).toBe(true);
  });
});
