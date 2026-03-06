import { describe, expect, it } from "bun:test";

import {
  mergeLogUpdate,
  parseDeviceLog,
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

describe("parseDeviceLog", () => {
  it("accepts a structured device log payload", () => {
    const result = parseDeviceLog({
      deviceId: "stack-001",
      level: "warn",
      code: "ota.failed",
      message: "OTA update failed.",
      bootId: "boot-001",
      firmwareVersion: "0.4.2",
      hardwareId: "esp32-a1",
      timestamp: 45678,
      metadata: {
        reason: "http-begin-failed",
        attempt: 1,
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("mergeLogUpdate", () => {
  it("prepends new logs and de-duplicates by id", () => {
    const merged = mergeLogUpdate(
      [
        {
          id: 1,
          deviceId: "stack-001",
          level: "info",
          code: "device.boot",
          message: "Device booted.",
          bootId: "boot-001",
          firmwareVersion: "0.4.1",
          hardwareId: "esp32-a1",
          deviceTimestamp: 12,
          metadata: null,
          receivedAt: new Date("2026-03-06T05:00:00.000Z").toISOString(),
        },
      ],
      {
        id: 2,
        deviceId: "stack-001",
        level: "warn",
        code: "ota.failed",
        message: "OTA update failed.",
        bootId: "boot-001",
        firmwareVersion: "0.4.2",
        hardwareId: "esp32-a1",
        deviceTimestamp: 18,
        metadata: { reason: "http-begin-failed" },
        receivedAt: new Date("2026-03-06T05:01:00.000Z").toISOString(),
      },
    );

    expect(merged.map((item) => item.id)).toEqual([2, 1]);
  });
});
