import { describe, expect, it } from "vitest";

import {
  buildAnalyticsChartData,
  buildAnalyticsOverview,
  buildAnalyticsSyncDisplay,
  formatMovingDuration,
  sortAnalyticsNodes,
} from "./analytics";

describe("buildAnalyticsChartData", () => {
  it("maps canonical analytics buckets into chart points", () => {
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
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
        lastSyncCompletedAt: new Date("2026-03-18T11:30:00.000Z").toISOString(),
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
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
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: new Date(2026, 2, 18, 12, 0, 0).toISOString(),
        lastSyncCompletedAt: new Date(2026, 2, 18, 11, 30, 0).toISOString(),
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
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
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: new Date(2026, 2, 18, 12, 0, 0).toISOString(),
        lastSyncCompletedAt: new Date(2026, 2, 18, 11, 30, 0).toISOString(),
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
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

  it("summarizes utilization and the busiest day for the 7d window", () => {
    const bucketStart = new Date(2026, 2, 17, 0, 0, 0);
    const bucketEnd = new Date(2026, 2, 18, 0, 0, 0);

    const overview = buildAnalyticsOverview({
      deviceId: "stack-001",
      window: "7d",
      generatedAt: new Date(2026, 2, 18, 12, 0, 0).toISOString(),
      source: "canonical",
      buckets: [
        {
          key: "7d-1",
          label: "Mar 17",
          startAt: bucketStart.toISOString(),
          endAt: bucketEnd.toISOString(),
          movementCount: 5,
          movingSeconds: 7_200,
        },
      ],
      totalMovementCount: 20,
      totalMovingSeconds: 7_200,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: new Date(2026, 2, 18, 12, 0, 0).toISOString(),
        lastSyncCompletedAt: new Date(2026, 2, 18, 11, 30, 0).toISOString(),
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    });

    expect(overview).toEqual({
      utilizationPercent: 1,
      activeTimeLabel: "2h",
      windowLabel: "last 7d",
      hasRecordedUse: true,
      movementStarts: 20,
      busiestPeriodLabel: "Tuesday",
      busiestPeriodDurationLabel: "2h",
    });
  });
});

describe("buildAnalyticsSyncDisplay", () => {
  it("returns a quiet complete state for idle analytics sync", () => {
    const display = buildAnalyticsSyncDisplay({
      deviceId: "stack-001",
      window: "24h",
      generatedAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
      source: "canonical",
      buckets: [],
      totalMovementCount: 0,
      totalMovingSeconds: 0,
      warningFlags: [],
      sync: {
        deviceId: "stack-001",
        state: "idle",
        detail: null,
        lastCanonicalAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
        lastSyncCompletedAt: new Date("2026-03-18T11:30:00.000Z").toISOString(),
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    });

    expect(display).toEqual({
      label: "History up to date",
      detail: null,
      tone: "neutral",
      showAnimation: false,
    });
  });

  it("returns an animated syncing state while catch-up is running", () => {
    const display = buildAnalyticsSyncDisplay({
      deviceId: "stack-001",
      window: "24h",
      generatedAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
      source: "cache",
      buckets: [],
      totalMovementCount: 0,
      totalMovingSeconds: 0,
      warningFlags: ["sync-delayed"],
      sync: {
        deviceId: "stack-001",
        state: "syncing",
        detail: null,
        lastCanonicalAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
        lastSyncCompletedAt: new Date("2026-03-18T11:30:00.000Z").toISOString(),
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    });

    expect(display).toEqual({
      label: "Syncing history",
      detail: "Live updates stay current while analytics catches up in the background.",
      tone: "muted",
      showAnimation: true,
    });
  });

  it("returns the failure detail when sync fails", () => {
    const display = buildAnalyticsSyncDisplay({
      deviceId: "stack-001",
      window: "24h",
      generatedAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
      source: "cache",
      buckets: [],
      totalMovementCount: 0,
      totalMovingSeconds: 0,
      warningFlags: ["sync-failed"],
      sync: {
        deviceId: "stack-001",
        state: "failed",
        detail: "Database unavailable",
        lastCanonicalAt: new Date("2026-03-18T12:00:00.000Z").toISOString(),
        lastSyncCompletedAt: new Date("2026-03-18T11:30:00.000Z").toISOString(),
        lastAckedSequence: 12,
        lastAckedBootId: "boot-1",
        lastOverflowDetectedAt: null,
      },
    });

    expect(display).toEqual({
      label: "History sync failed",
      detail: "Database unavailable",
      tone: "warning",
      showAnimation: false,
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
        isConnected: false,
        connectionState: "disconnected",
        isMoving: false,
        signalStrength: null,
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
        isConnected: true,
        connectionState: "connected",
        isMoving: true,
        signalStrength: 80,
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
        isConnected: false,
        connectionState: "reconnecting",
        isMoving: false,
        signalStrength: null,
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
