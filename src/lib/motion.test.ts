import { describe, expect, it } from "bun:test";

import { parseIngestPayload } from "@/lib/motion";

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

describe("timestamp semantics", () => {
  it("accepts device millis as an integer payload field", () => {
    const result = parseIngestPayload({
      deviceId: "stack-001",
      state: "still",
      timestamp: 123456,
      delta: 0,
    });

    expect(result.success).toBe(true);
  });
});
