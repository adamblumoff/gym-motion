import { describe, expect, it } from "bun:test";

import { buildSignalHistory, calculateAverageSignal, buildMovementData } from "./analytics";

describe("buildMovementData", () => {
  it("buckets motion by device event time instead of receipt time", () => {
    const eventTimestamp = Date.parse("2026-03-14T09:15:00.000Z");
    const expectedHour = `${new Date(eventTimestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
    })}:00`;
    const chart = buildMovementData([
      {
        id: 1,
        deviceId: "stack-001",
        sequence: 1,
        state: "moving",
        delta: 22,
        eventTimestamp,
        receivedAt: new Date("2026-03-14T14:45:00.000Z").toISOString(),
        bootId: "boot-1",
        firmwareVersion: "0.5.1",
        hardwareId: "hw-1",
      },
    ]);

    expect(chart).toEqual([{ hour: expectedHour, movements: 1 }]);
  });
});

describe("calculateAverageSignal", () => {
  it("averages only populated signal slots", () => {
    const series = [
      {
        id: "device:stack-001",
        deviceId: "stack-001",
        name: "Leg Press",
        color: "#3b82f6",
      },
    ];

    expect(
      calculateAverageSignal(
        {
          time: "09:15",
          "device:stack-001": 80,
        },
        series,
      ),
    ).toBe(80);
  });
});

describe("buildSignalHistory", () => {
  it("uses event time for chart labels", () => {
    const eventTimestamp = Date.parse("2026-03-14T09:15:00.000Z");
    const expectedTime = new Date(eventTimestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });

    const history = buildSignalHistory(
      [
        {
          id: 1,
          deviceId: "stack-001",
          sequence: 1,
          state: "moving",
          delta: 15,
          eventTimestamp,
          receivedAt: new Date("2026-03-14T14:45:00.000Z").toISOString(),
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      ],
      [
        {
          id: "stack-001",
          name: "Leg Press",
          macAddress: "peripheral-1",
          isConnected: true,
          connectionState: "connected",
          healthStatus: "online",
          telemetryFreshness: "fresh",
          isMoving: true,
          signalStrength: 60,
          batteryLevel: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: false,
          logs: [],
        },
      ],
    );

    expect(history.points[0]?.time).toBe(expectedTime);
  });

  it("keeps per-event signal levels for a single active node", () => {
    const history = buildSignalHistory(
      [
        {
          id: 1,
          deviceId: "stack-001",
          sequence: 1,
          state: "moving",
          delta: 10,
          eventTimestamp: Date.parse("2026-03-14T09:15:00.000Z"),
          receivedAt: new Date("2026-03-14T09:15:01.000Z").toISOString(),
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
        {
          id: 2,
          deviceId: "stack-001",
          sequence: 2,
          state: "moving",
          delta: 40,
          eventTimestamp: Date.parse("2026-03-14T09:16:00.000Z"),
          receivedAt: new Date("2026-03-14T09:16:01.000Z").toISOString(),
          bootId: "boot-1",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-1",
        },
      ],
      [
        {
          id: "stack-001",
          name: "Leg Press",
          macAddress: "peripheral-1",
          isConnected: true,
          connectionState: "connected",
          healthStatus: "online",
          telemetryFreshness: "fresh",
          isMoving: true,
          signalStrength: 80,
          batteryLevel: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: false,
          logs: [],
        },
      ],
    );

    const signalKey = history.series[0]?.id;
    expect(signalKey).toBe("device:stack-001");
    expect(history.points[0]?.[signalKey ?? ""]).toBe(35);
    expect(history.points[1]?.[signalKey ?? ""]).toBe(65);
  });

  it("does not project a later node sample backward into earlier buckets", () => {
    const history = buildSignalHistory(
      [
        {
          id: 1,
          deviceId: "node-a",
          sequence: 1,
          state: "moving",
          delta: 20,
          eventTimestamp: Date.parse("2026-03-14T10:00:00.000Z"),
          receivedAt: new Date("2026-03-14T10:00:01.000Z").toISOString(),
          bootId: "boot-a",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-a",
        },
        {
          id: 2,
          deviceId: "node-a",
          sequence: 2,
          state: "moving",
          delta: 30,
          eventTimestamp: Date.parse("2026-03-14T10:01:00.000Z"),
          receivedAt: new Date("2026-03-14T10:01:01.000Z").toISOString(),
          bootId: "boot-a",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-a",
        },
        {
          id: 3,
          deviceId: "node-b",
          sequence: 1,
          state: "moving",
          delta: 50,
          eventTimestamp: Date.parse("2026-03-14T10:02:00.000Z"),
          receivedAt: new Date("2026-03-14T10:02:01.000Z").toISOString(),
          bootId: "boot-b",
          firmwareVersion: "0.5.1",
          hardwareId: "hw-b",
        },
      ],
      [
        {
          id: "node-a",
          name: "Node A",
          macAddress: "peripheral-a",
          isConnected: true,
          connectionState: "connected",
          healthStatus: "online",
          telemetryFreshness: "fresh",
          isMoving: true,
          signalStrength: 70,
          batteryLevel: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: false,
          logs: [],
        },
        {
          id: "node-b",
          name: "Node B",
          macAddress: "peripheral-b",
          isConnected: true,
          connectionState: "connected",
          healthStatus: "online",
          telemetryFreshness: "fresh",
          isMoving: true,
          signalStrength: 65,
          batteryLevel: null,
          reconnectAttempt: 0,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: false,
          logs: [],
        },
      ],
    );

    const nodeBSeries = history.series.find((entry) => entry.deviceId === "node-b");
    expect(nodeBSeries?.id).toBe("device:node-b");
    expect(history.points[0]?.[nodeBSeries?.id ?? ""]).toBe(65);
    expect(history.points[1]?.[nodeBSeries?.id ?? ""]).toBe(65);
    expect(history.points[2]?.[nodeBSeries?.id ?? ""]).toBe(75);
  });

  it("keeps signal series mapped to stable device ids when node order changes", () => {
    const events = [
      {
        id: 1,
        deviceId: "node-a",
        sequence: 1,
        state: "moving" as const,
        delta: 20,
        eventTimestamp: Date.parse("2026-03-14T10:00:00.000Z"),
        receivedAt: new Date("2026-03-14T10:00:01.000Z").toISOString(),
        bootId: "boot-a",
        firmwareVersion: "0.5.1",
        hardwareId: "hw-a",
      },
      {
        id: 2,
        deviceId: "node-b",
        sequence: 1,
        state: "moving" as const,
        delta: 50,
        eventTimestamp: Date.parse("2026-03-14T10:01:00.000Z"),
        receivedAt: new Date("2026-03-14T10:01:01.000Z").toISOString(),
        bootId: "boot-b",
        firmwareVersion: "0.5.1",
        hardwareId: "hw-b",
      },
    ];
    const nodesInFirstOrder = [
      {
        id: "node-a",
        name: "Node A",
        macAddress: "peripheral-a",
        isConnected: true,
        connectionState: "connected" as const,
        healthStatus: "online" as const,
        telemetryFreshness: "fresh" as const,
        isMoving: true,
        signalStrength: 70,
        batteryLevel: null,
        reconnectAttempt: 0,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        logs: [],
      },
      {
        id: "node-b",
        name: "Node B",
        macAddress: "peripheral-b",
        isConnected: true,
        connectionState: "connected" as const,
        healthStatus: "online" as const,
        telemetryFreshness: "fresh" as const,
        isMoving: true,
        signalStrength: 65,
        batteryLevel: null,
        reconnectAttempt: 0,
        reconnectAttemptLimit: 20,
        reconnectRetryExhausted: false,
        logs: [],
      },
    ];
    const nodesInSecondOrder = [...nodesInFirstOrder].reverse();

    const firstHistory = buildSignalHistory(events, nodesInFirstOrder);
    const secondHistory = buildSignalHistory(events, nodesInSecondOrder);

    expect(secondHistory).toEqual(firstHistory);
  });
});

