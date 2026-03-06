import { describe, expect, it } from "bun:test";

import { parseIngestPayload, toEventDate } from "@/lib/motion";

describe("parseIngestPayload", () => {
  it("accepts a valid motion event payload", () => {
    const result = parseIngestPayload({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1710000000000,
      delta: 42,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid state", () => {
    const result = parseIngestPayload({
      deviceId: "stack-001",
      state: "walking",
      timestamp: 1710000000000,
    });

    expect(result.success).toBe(false);
  });
});

describe("toEventDate", () => {
  it("turns epoch milliseconds into a valid date", () => {
    expect(toEventDate(1710000000000).toISOString()).toBe(
      "2024-03-09T16:00:00.000Z",
    );
  });
});
