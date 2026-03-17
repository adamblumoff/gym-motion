import { describe, expect, it } from "bun:test";

import type { DesktopSnapshot } from "@core/contracts";

import {
  buildLiveMovementAnalytics,
  combineMovementAnalytics,
  formatDurationLabel,
  summarizeMovementChart,
} from "./analytics";

const BASE_SNAPSHOT: DesktopSnapshot = {
  liveStatus: "Gateway live",
  trayHint: "Gateway live",
  runtimeState: "running",
  gatewayIssue: null,
  gateway: {
    hostname: "local",
    mode: "desktop",
    sessionId: "session-1",
    adapterState: "poweredOn",
    scanState: "stopped",
    connectedNodeCount: 1,
    reconnectingNodeCount: 0,
    knownNodeCount: 1,
    startedAt: "2026-03-17T10:00:00.000Z",
    updatedAt: "2026-03-17T10:00:00.000Z",
    lastAdvertisementAt: null,
  },
  devices: [
    {
      id: "stack-001",
      lastState: "moving",
      lastSeenAt: Date.parse("2026-03-17T10:20:00.000Z"),
      lastDelta: 20,
      updatedAt: "2026-03-17T10:20:00.000Z",
      hardwareId: "hw-1",
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      machineLabel: "Leg Press",
      siteId: "site-1",
      provisioningState: "provisioned",
      updateStatus: "idle",
      updateTargetVersion: null,
      updateDetail: null,
      updateUpdatedAt: null,
      lastHeartbeatAt: null,
      lastEventReceivedAt: "2026-03-17T10:20:00.000Z",
      healthStatus: "online",
      gatewayConnectionState: "connected",
      telemetryFreshness: "fresh",
      peripheralId: "peripheral-1",
      address: null,
      gatewayLastAdvertisementAt: null,
      gatewayLastConnectedAt: "2026-03-17T10:00:00.000Z",
      gatewayLastDisconnectedAt: null,
      gatewayLastTelemetryAt: "2026-03-17T10:20:00.000Z",
      gatewayDisconnectReason: null,
      advertisedName: "Leg Press",
      lastRssi: -58,
      otaStatus: "idle",
      otaTargetVersion: null,
      otaProgressBytesSent: null,
      otaTotalBytes: null,
      otaLastPhase: null,
      otaFailureDetail: null,
      otaLastStatusMessage: null,
      otaUpdatedAt: null,
      reconnectAttempt: 0,
      reconnectAttemptLimit: 20,
      reconnectRetryExhausted: false,
      reconnectAwaitingDecision: false,
    },
  ],
  events: [
    {
      id: 1,
      deviceId: "stack-001",
      sequence: 1,
      state: "moving",
      delta: 20,
      eventTimestamp: 1,
      receivedAt: "2026-03-17T10:05:00.000Z",
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    },
  ],
  logs: [],
  activities: [],
};

describe("buildLiveMovementAnalytics", () => {
  it("extends an open moving span to now for live provisional analytics", () => {
    const analytics = buildLiveMovementAnalytics({
      snapshot: BASE_SNAPSHOT,
      deviceId: "stack-001",
      range: "24h",
      now: new Date("2026-03-17T10:20:00.000Z"),
      provisionalStartAt: new Date("2026-03-17T10:00:00.000Z"),
    });

    const firstBucket = analytics?.buckets.find(
      (bucket) => bucket.bucketStartAt === "2026-03-17T10:00:00.000Z",
    );
    const secondBucket = analytics?.buckets.find(
      (bucket) => bucket.bucketStartAt === "2026-03-17T10:15:00.000Z",
    );

    expect(firstBucket?.movementCount).toBe(1);
    expect(firstBucket?.movementDurationMs).toBe(10 * 60 * 1000);
    expect(secondBucket?.movementDurationMs).toBe(5 * 60 * 1000);
  });
});

describe("combineMovementAnalytics", () => {
  it("adds provisional tail buckets on top of canonical data", () => {
    const combined = combineMovementAnalytics(
      {
        deviceId: "stack-001",
        range: "24h",
        rangeStartAt: "2026-03-17T10:00:00.000Z",
        rangeEndAt: "2026-03-17T10:30:00.000Z",
        timezone: "UTC",
        bucketSizeMs: 15 * 60 * 1000,
        buckets: [
          {
            bucketStartAt: "2026-03-17T10:00:00.000Z",
            bucketEndAt: "2026-03-17T10:15:00.000Z",
            label: "10:00",
            movementCount: 1,
            movementDurationMs: 10 * 60 * 1000,
          },
        ],
        lastCanonicalEventAt: "2026-03-17T10:15:00.000Z",
        lastComputedAt: "2026-03-17T10:16:00.000Z",
        hasCanonicalHistory: true,
        hasOlderHistory: false,
        compactionNotice: null,
      },
      {
        deviceId: "stack-001",
        range: "24h",
        rangeStartAt: "2026-03-17T10:15:00.000Z",
        rangeEndAt: "2026-03-17T10:30:00.000Z",
        timezone: "UTC",
        bucketSizeMs: 15 * 60 * 1000,
        buckets: [
          {
            bucketStartAt: "2026-03-17T10:15:00.000Z",
            bucketEndAt: "2026-03-17T10:30:00.000Z",
            label: "10:15",
            movementCount: 1,
            movementDurationMs: 5 * 60 * 1000,
          },
        ],
        lastCanonicalEventAt: null,
        lastComputedAt: "2026-03-17T10:20:00.000Z",
        hasCanonicalHistory: true,
        hasOlderHistory: false,
        compactionNotice: null,
      },
    );

    expect(combined).toHaveLength(2);
    expect(combined[1]?.provisionalMovementDurationMinutes).toBe(5);
    expect(combined[1]?.movementCount).toBe(1);
  });
});

describe("movement analytics summaries", () => {
  it("formats total duration labels compactly", () => {
    expect(formatDurationLabel(45)).toBe("45m");
    expect(formatDurationLabel(120)).toBe("2h");
    expect(formatDurationLabel(135)).toBe("2h 15m");
  });

  it("sums chart totals across canonical and provisional buckets", () => {
    expect(
      summarizeMovementChart([
        {
          bucketStartAt: "2026-03-17T10:00:00.000Z",
          label: "10:00",
          movementCount: 1,
          movementDurationMinutes: 10,
          canonicalMovementCount: 1,
          canonicalMovementDurationMinutes: 10,
          provisionalMovementCount: 0,
          provisionalMovementDurationMinutes: 0,
        },
        {
          bucketStartAt: "2026-03-17T10:15:00.000Z",
          label: "10:15",
          movementCount: 1,
          movementDurationMinutes: 5,
          canonicalMovementCount: 0,
          canonicalMovementDurationMinutes: 0,
          provisionalMovementCount: 1,
          provisionalMovementDurationMinutes: 5,
        },
      ]),
    ).toEqual({
      movementCount: 2,
      movementDurationMinutes: 15,
    });
  });
});
