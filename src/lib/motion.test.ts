import { describe, expect, it } from "bun:test";

import {
  parseDeviceAssignment,
  parseFirmwareRelease,
  parseHeartbeatPayload,
  parseIngestPayload,
} from "@/lib/motion";

describe("parseIngestPayload", () => {
  it("accepts a valid motion event payload", () => {
    const result = parseIngestPayload({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 1710000000000,
      delta: 42,
      bootId: "boot-001",
      firmwareVersion: "0.2.0",
      hardwareId: "esp32-a1",
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

describe("parseHeartbeatPayload", () => {
  it("accepts a valid heartbeat payload", () => {
    const result = parseHeartbeatPayload({
      deviceId: "stack-001",
      timestamp: 54321,
      bootId: "boot-001",
      firmwareVersion: "0.2.0",
    });

    expect(result.success).toBe(true);
  });
});

describe("parseDeviceAssignment", () => {
  it("accepts device setup metadata", () => {
    const result = parseDeviceAssignment({
      machineLabel: "Leg Press 2",
      siteId: "gym-dallas",
      hardwareId: "esp32-a1",
      provisioningState: "assigned",
    });

    expect(result.success).toBe(true);
  });
});

describe("parseFirmwareRelease", () => {
  it("accepts firmware release metadata", () => {
    const result = parseFirmwareRelease({
      version: "0.2.0",
      gitSha: "abcdef1",
      assetUrl: "firmware/0.2.0/gym_motion.ino.bin",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      md5: "0123456789abcdef0123456789abcdef",
      sizeBytes: 245760,
      rolloutState: "active",
    });

    expect(result.success).toBe(true);
  });
});
