import { describe, expect, it } from "vitest";

import { canonicalNodeStatus, isBlockingSensorIssue } from "./node-status";

describe("isBlockingSensorIssue", () => {
  it("treats sensor_no_data as a soft stale-sample condition", () => {
    expect(isBlockingSensorIssue("sensor_no_data")).toBe(false);
    expect(isBlockingSensorIssue("sensor_bus_recovery")).toBe(true);
    expect(isBlockingSensorIssue(null)).toBe(false);
  });
});

describe("canonicalNodeStatus", () => {
  it("keeps healthy connected motion states even when the sample stream is briefly stale", () => {
    expect(
      canonicalNodeStatus({
        connectionState: "connected",
        lastState: "still",
        sensorIssue: "sensor_no_data",
      }),
    ).toBe("still");

    expect(
      canonicalNodeStatus({
        connectionState: "connected",
        lastState: "moving",
        sensorIssue: "sensor_no_data",
      }),
    ).toBe("moving");
  });
});
