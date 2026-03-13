import { describe, expect, it } from "bun:test";

import {
  parseBackfillBatch,
  mergeActivityUpdate,
  mergeGatewayDeviceUpdate,
  mergeLogUpdate,
  parseDeviceLog,
  parseDeviceAssignment,
  parseDeviceRegistration,
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

describe("parseDeviceRegistration", () => {
  it("accepts a device placeholder registration", () => {
    const result = parseDeviceRegistration({
      deviceId: "stack-004",
      machineLabel: "Lat Pulldown 1",
      siteId: "gym-dallas",
      hardwareId: "esp32-a4",
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

describe("parseBackfillBatch", () => {
  it("accepts a mixed backfill payload with ordered node records", () => {
    const result = parseBackfillBatch({
      deviceId: "stack-001",
      bootId: "boot-001",
      ackSequence: 14,
      records: [
        {
          kind: "motion",
          sequence: 13,
          state: "moving",
          delta: 22,
          timestamp: 101,
          bootId: "boot-001",
        },
        {
          kind: "node-log",
          sequence: 14,
          level: "warn",
          code: "history.overflow",
          message: "History journal dropped records.",
          timestamp: 102,
          bootId: "boot-001",
        },
      ],
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

describe("mergeActivityUpdate", () => {
  it("keeps a merged device timeline newest-first across motion and lifecycle items", () => {
    const merged = mergeActivityUpdate(
      [
        {
          id: "log-1",
          deviceId: "stack-001",
          kind: "lifecycle",
          title: "node.connected",
          message: "Gateway connected to stack-001.",
          state: null,
          level: "info",
          code: "node.connected",
          delta: null,
          eventTimestamp: 20,
          receivedAt: new Date("2026-03-06T05:00:00.000Z").toISOString(),
          bootId: "boot-001",
          firmwareVersion: "0.5.0",
          hardwareId: "node-001",
          metadata: null,
        },
      ],
      {
        id: "motion-2",
        deviceId: "stack-001",
        kind: "motion",
        title: "MOVING",
        message: "Gateway recorded moving for stack-001.",
        state: "moving",
        level: null,
        code: "motion.state",
        delta: 18,
        eventTimestamp: 25,
        receivedAt: new Date("2026-03-06T05:01:00.000Z").toISOString(),
        bootId: "boot-001",
        firmwareVersion: "0.5.0",
        hardwareId: "node-001",
        metadata: { delta: 18 },
      },
    );

    expect(merged.map((item) => item.id)).toEqual(["motion-2", "log-1"]);
  });
});

describe("mergeGatewayDeviceUpdate", () => {
  it("replaces a device snapshot by id and keeps the newest snapshot first", () => {
    const merged = mergeGatewayDeviceUpdate(
      [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: 10,
          lastDelta: 0,
          updatedAt: new Date("2026-03-06T05:00:00.000Z").toISOString(),
          hardwareId: "node-001",
          bootId: "boot-001",
          firmwareVersion: "0.5.0",
          machineLabel: "Row 1",
          siteId: "north",
          provisioningState: "provisioned",
          updateStatus: "idle",
          lastHeartbeatAt: null,
          lastEventReceivedAt: null,
          healthStatus: "online",
          gatewayConnectionState: "connected",
          peripheralId: "peripheral-001",
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: new Date("2026-03-06T05:00:00.000Z").toISOString(),
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: new Date("2026-03-06T05:00:00.000Z").toISOString(),
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-000001",
          lastRssi: -44,
        },
      ],
      {
        id: "stack-001",
        lastState: "moving",
        lastSeenAt: 99,
        lastDelta: 21,
        updatedAt: new Date("2026-03-06T05:01:00.000Z").toISOString(),
        hardwareId: "node-001",
        bootId: "boot-001",
        firmwareVersion: "0.5.0",
        machineLabel: "Row 1",
        siteId: "north",
        provisioningState: "provisioned",
        updateStatus: "idle",
        lastHeartbeatAt: null,
        lastEventReceivedAt: null,
        healthStatus: "online",
        gatewayConnectionState: "connected",
        peripheralId: "peripheral-001",
        gatewayLastAdvertisementAt: null,
        gatewayLastConnectedAt: new Date("2026-03-06T05:00:00.000Z").toISOString(),
        gatewayLastDisconnectedAt: null,
        gatewayLastTelemetryAt: new Date("2026-03-06T05:01:00.000Z").toISOString(),
        gatewayDisconnectReason: null,
        advertisedName: "GymMotion-000001",
        lastRssi: -40,
      },
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.lastState).toBe("moving");
    expect(merged[0]?.lastSeenAt).toBe(99);
  });
});
