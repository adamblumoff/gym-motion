import { describe, expect, it } from "vitest";

import {
  buildAnalyticsChartData,
  buildAnalyticsOverview,
  formatMovingDuration,
  sortAnalyticsNodes,
} from "./analytics";

describe("buildAnalyticsChartData", () => {
  it("maps analytics buckets into chart points", () => {
    const chart = buildAnalyticsChartData({
      deviceId: "stack-001",
      window: "24h",
      generatedAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
      source: "canonical",
      buckets: [
        {
          key: "24h-1",
          label: "09",
          startAt: new Date("2026-03-18T09:00:00.000Z").toISOString(),
          endAt: new Date("2026-03-18T10:00:00.000Z").toISOString(),
          movementCount: 3,
          movingSeconds: 900,
        },
      ],
      totalMovementCount: 3,
      totalMovingSeconds: 900,
    });

    expect(chart).toEqual([
      {
        label: "09",
        movements: 3,
        movingMinutes: 15,
      },
    ]);
  });
});

describe("formatMovingDuration", () => {
  it("formats mixed hour and minute durations", () => {
    expect(formatMovingDuration(5_400)).toBe("1h 30m");
  });
});

describe("buildAnalyticsOverview", () => {
  it("summarizes utilization and the busiest hour for the 24h window", () => {
    const bucketStart = new Date(2026, 2, 18, 9, 0, 0);
    const bucketEnd = new Date(2026, 2, 18, 10, 0, 0);

    const overview = buildAnalyticsOverview({
      deviceId: "stack-001",
      window: "24h",
      generatedAt: new Date(2026, 2, 18, 12, 0, 0).toISOString(),
      source: "canonical",
      buckets: [
        {
          key: "24h-1",
          label: "09",
          startAt: bucketStart.toISOString(),
          endAt: bucketEnd.toISOString(),
          movementCount: 4,
          movingSeconds: 3_600,
        },
      ],
      totalMovementCount: 12,
      totalMovingSeconds: 5_400,
    });

    expect(overview).toEqual({
      utilizationPercent: 6,
      activeTimeLabel: "1h 30m",
      windowLabel: "last 24h",
      hasRecordedUse: true,
      movementStarts: 12,
      busiestPeriodLabel: "9 AM - 10 AM",
      busiestPeriodDurationLabel: "1h",
    });
  });

  it("keeps the busiest period empty when there is no recorded use", () => {
    const bucketStart = new Date(2026, 2, 18, 9, 0, 0);
    const bucketEnd = new Date(2026, 2, 18, 10, 0, 0);

    const overview = buildAnalyticsOverview({
      deviceId: "stack-001",
      window: "24h",
      generatedAt: new Date(2026, 2, 18, 12, 0, 0).toISOString(),
      source: "canonical",
      buckets: [
        {
          key: "24h-1",
          label: "09",
          startAt: bucketStart.toISOString(),
          endAt: bucketEnd.toISOString(),
          movementCount: 0,
          movingSeconds: 0,
        },
      ],
      totalMovementCount: 0,
      totalMovingSeconds: 0,
    });

    expect(overview).toEqual({
      utilizationPercent: 0,
      activeTimeLabel: "0m",
      windowLabel: "last 24h",
      hasRecordedUse: false,
      movementStarts: 0,
      busiestPeriodLabel: null,
      busiestPeriodDurationLabel: null,
    });
  });
});

describe("sortAnalyticsNodes", () => {
  it("sorts connected nodes ahead of reconnecting and disconnected nodes", () => {
    const sorted = sortAnalyticsNodes([
      {
        id: "node-c",
        name: "Disconnected Node",
        macAddress: null,
        connectionState: "disconnected",
        connectionStatus: "disconnected",
        sensorStatus: "healthy",
        motionStatus: "still",
        visualTone: "offline",
        isMoving: false,
        lastState: "still",
        sensorIssue: null,
        lastDelta: null,
        lastTelemetryAt: null,
        signalStrength: null,
        lastDisconnectReason: null,
        reconnectAttempt: 0,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
        logs: [],
      },
      {
        id: "node-a",
        name: "Connected Node",
        macAddress: null,
        connectionState: "connected",
        connectionStatus: "connected",
        sensorStatus: "healthy",
        motionStatus: "moving",
        visualTone: "moving",
        isMoving: true,
        lastState: "moving",
        sensorIssue: null,
        lastDelta: 1,
        lastTelemetryAt: null,
        signalStrength: 80,
        lastDisconnectReason: null,
        reconnectAttempt: 0,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
        logs: [],
      },
      {
        id: "node-b",
        name: "Reconnecting Node",
        macAddress: null,
        connectionState: "reconnecting",
        connectionStatus: "reconnecting",
        sensorStatus: "healthy",
        motionStatus: "still",
        visualTone: "warning",
        isMoving: false,
        lastState: "still",
        sensorIssue: null,
        lastDelta: null,
        lastTelemetryAt: null,
        signalStrength: null,
        lastDisconnectReason: null,
        reconnectAttempt: 2,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        reconnectAwaitingDecision: false,
        logs: [],
      },
    ]);

    expect(sorted.map((node) => node.id)).toEqual(["node-a", "node-b", "node-c"]);
  });
});
