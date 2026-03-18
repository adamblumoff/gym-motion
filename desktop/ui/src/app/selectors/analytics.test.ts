import { describe, expect, it } from "bun:test";

import {
  buildAnalyticsChartData,
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
