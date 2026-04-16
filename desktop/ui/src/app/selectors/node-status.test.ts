import { describe, expect, it } from "vitest";

import {
  connectionStatusForNode,
  isActivelyMoving,
  isBlockingSensorIssue,
  motionStatusForNode,
  nodeVisualTone,
  sensorStatusForNode,
} from "./node-status";

describe("isBlockingSensorIssue", () => {
  it("treats sensor_no_data as a soft stale-sample condition", () => {
    expect(isBlockingSensorIssue("sensor_no_data")).toBe(false);
    expect(isBlockingSensorIssue("sensor_bus_recovery")).toBe(true);
    expect(isBlockingSensorIssue(null)).toBe(false);
  });
});

describe("connectionStatusForNode", () => {
  it("keeps reconnecting separate from disconnected", () => {
    expect(connectionStatusForNode({ connectionState: "connected" })).toBe("connected");
    expect(connectionStatusForNode({ connectionState: "connecting" })).toBe("reconnecting");
    expect(connectionStatusForNode({ connectionState: "reconnecting" })).toBe("reconnecting");
    expect(connectionStatusForNode({ connectionState: "disconnected" })).toBe("disconnected");
  });
});

describe("sensorStatusForNode", () => {
  it("splits healthy, waiting, and fault states", () => {
    expect(sensorStatusForNode({ sensorIssue: null })).toBe("healthy");
    expect(sensorStatusForNode({ sensorIssue: "sensor_no_data" })).toBe("waiting_for_sample");
    expect(sensorStatusForNode({ sensorIssue: "sensor_bus_recovery" })).toBe("fault");
  });
});

describe("motionStatusForNode", () => {
  it("mirrors the last reported motion state", () => {
    expect(motionStatusForNode({ lastState: "moving" })).toBe("moving");
    expect(motionStatusForNode({ lastState: "still" })).toBe("still");
  });
});

describe("nodeVisualTone", () => {
  it("prioritizes faults and reconnecting for icon tone without collapsing the display state", () => {
    expect(
      nodeVisualTone({
        connectionState: "connected",
        lastState: "moving",
        sensorIssue: "sensor_bus_recovery",
      }),
    ).toBe("warning");

    expect(
      nodeVisualTone({
        connectionState: "reconnecting",
        lastState: "moving",
        sensorIssue: null,
      }),
    ).toBe("warning");

    expect(
      nodeVisualTone({
        connectionState: "disconnected",
        lastState: "moving",
        sensorIssue: null,
      }),
    ).toBe("offline");

    expect(
      nodeVisualTone({
        connectionState: "connected",
        lastState: "moving",
        sensorIssue: null,
      }),
    ).toBe("moving");
  });
});

describe("isActivelyMoving", () => {
  it("only reports active movement when the node is connected and the sensor is healthy", () => {
    expect(
      isActivelyMoving({
        connectionState: "connected",
        lastState: "moving",
        sensorIssue: null,
      }),
    ).toBe(true);

    expect(
      isActivelyMoving({
        connectionState: "connected",
        lastState: "moving",
        sensorIssue: "sensor_no_data",
      }),
    ).toBe(false);

    expect(
      isActivelyMoving({
        connectionState: "disconnected",
        lastState: "moving",
        sensorIssue: null,
      }),
    ).toBe(false);
  });
});
