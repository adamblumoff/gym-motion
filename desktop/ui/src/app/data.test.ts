import { describe, expect, it } from "bun:test";

import type { DesktopSnapshot } from "@core/contracts";

import {
  buildBluetoothNodes,
  buildPairedDevices,
  buildSetupVisibleDevices,
  buildMovementData,
  buildSignalHistory,
  calculateAverageSignal,
} from "./data";

describe("buildBluetoothNodes", () => {
  it("preserves non-connected gateway states instead of flattening them to offline", () => {
    const snapshot: DesktopSnapshot = {
      liveStatus: "Gateway live",
      trayHint: "Waiting",
      runtimeState: "running",
      gatewayIssue: null,
      gateway: {
        hostname: "test-host",
        mode: "reference-ble-node-gateway",
        sessionId: "session-1",
        adapterState: "poweredOn",
        scanState: "scanning",
        connectedNodeCount: 0,
        reconnectingNodeCount: 1,
        knownNodeCount: 1,
        startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
      },
      devices: [
        {
          id: "stack-001",
          lastState: "moving",
          lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
          lastDelta: 12,
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-1",
          firmwareVersion: "0.5.0",
          machineLabel: "Leg Press",
          siteId: "Dallas",
          provisioningState: "provisioned",
          updateStatus: "idle",
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: null,
          healthStatus: "stale",
          gatewayConnectionState: "reconnecting",
          telemetryFreshness: "fresh",
          peripheralId: "peripheral-1",
          gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -62,
          otaStatus: "idle",
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
          reconnectAttempt: 2,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: false,
        },
      ],
      events: [],
      logs: [],
      activities: [],
    };

    const [node] = buildBluetoothNodes(snapshot);

    expect(node?.connectionState).toBe("reconnecting");
    expect(node?.isConnected).toBe(false);
    expect(node?.isMoving).toBe(false);
  });

  it("does not show disconnected nodes as moving just because their last telemetry was fresh", () => {
    const snapshot: DesktopSnapshot = {
      liveStatus: "Gateway live",
      trayHint: "Waiting",
      runtimeState: "running",
      gatewayIssue: null,
      gateway: {
        hostname: "test-host",
        mode: "reference-ble-node-gateway",
        sessionId: "session-1",
        adapterState: "poweredOn",
        scanState: "scanning",
        connectedNodeCount: 0,
        reconnectingNodeCount: 0,
        knownNodeCount: 1,
        startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
      },
      devices: [
        {
          id: "stack-001",
          lastState: "moving",
          lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
          lastDelta: 12,
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-1",
          firmwareVersion: "0.5.0",
          machineLabel: "Leg Press",
          siteId: "Dallas",
          provisioningState: "provisioned",
          updateStatus: "idle",
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: null,
          healthStatus: "offline",
          gatewayConnectionState: "disconnected",
          telemetryFreshness: "fresh",
          peripheralId: "peripheral-1",
          gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
          gatewayLastDisconnectedAt: new Date("2026-03-14T20:05:05.000Z").toISOString(),
          gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayDisconnectReason: "link lost",
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -62,
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
        },
      ],
      events: [],
      logs: [],
      activities: [],
    };

    const [node] = buildBluetoothNodes(snapshot);

    expect(node?.connectionState).toBe("disconnected");
    expect(node?.telemetryFreshness).toBe("fresh");
    expect(node?.isConnected).toBe(false);
    expect(node?.isMoving).toBe(false);
  });

  it("surfaces reconnect exhaustion metadata for homepage recovery prompts", () => {
    const snapshot: DesktopSnapshot = {
      liveStatus: "Waiting for approved BLE nodes",
      trayHint: "Waiting",
      runtimeState: "running",
      gatewayIssue: null,
      gateway: {
        hostname: "test-host",
        mode: "reference-ble-node-gateway",
        sessionId: "session-1",
        adapterState: "poweredOn",
        scanState: "stopped",
        connectedNodeCount: 0,
        reconnectingNodeCount: 0,
        knownNodeCount: 1,
        startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        lastAdvertisementAt: null,
      },
      devices: [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
          lastDelta: null,
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-1",
          firmwareVersion: "0.5.0",
          machineLabel: "Leg Press",
          siteId: "Dallas",
          provisioningState: "provisioned",
          updateStatus: "idle",
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: null,
          healthStatus: "offline",
          gatewayConnectionState: "disconnected",
          telemetryFreshness: "missing",
          peripheralId: "peripheral-1",
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
          gatewayLastDisconnectedAt: new Date("2026-03-14T20:05:05.000Z").toISOString(),
          gatewayLastTelemetryAt: null,
          gatewayDisconnectReason: "retry limit reached",
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -62,
          otaStatus: "idle",
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
          reconnectAttempt: 20,
          reconnectAttemptLimit: 20,
          reconnectRetryExhausted: true,
        },
      ],
      events: [],
      logs: [],
      activities: [],
    };

    const [node] = buildBluetoothNodes(snapshot);

    expect(node?.reconnectAttempt).toBe(20);
    expect(node?.reconnectAttemptLimit).toBe(20);
    expect(node?.reconnectRetryExhausted).toBe(true);
  });

  it("prefers the stable BLE address over an opaque runtime peripheral id", () => {
    const snapshot: DesktopSnapshot = {
      liveStatus: "Gateway live",
      trayHint: "Waiting",
      runtimeState: "running",
      gatewayIssue: null,
      gateway: {
        hostname: "test-host",
        mode: "reference-ble-node-gateway",
        sessionId: "session-1",
        adapterState: "poweredOn",
        scanState: "stopped",
        connectedNodeCount: 1,
        reconnectingNodeCount: 0,
        knownNodeCount: 1,
        startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
      },
      devices: [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
          lastDelta: 0,
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-1",
          firmwareVersion: "0.5.0",
          machineLabel: "Leg Press",
          siteId: "Dallas",
          provisioningState: "provisioned",
          updateStatus: "idle",
          updateTargetVersion: null,
          updateDetail: null,
          updateUpdatedAt: null,
          lastHeartbeatAt: null,
          lastEventReceivedAt: null,
          healthStatus: "online",
          gatewayConnectionState: "connected",
          telemetryFreshness: "fresh",
          peripheralId: "opaque-winrt-handle",
          address: "AA:BB:CC:DD:EE:FF",
          gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -55,
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
        },
      ],
      events: [],
      logs: [],
      activities: [],
    };

    const [node] = buildBluetoothNodes(snapshot);

    expect(node?.macAddress).toBe("AA:BB:CC:DD:EE:FF");
  });
});

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
    expect(
      calculateAverageSignal({
        sensorA: 80,
        sensorB: 0,
        sensorC: 0,
        sensorD: 0,
        sensorE: 0,
      }),
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

    expect(history[0]?.time).toBe(expectedTime);
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

    expect(history[0]?.sensorA).toBe(35);
    expect(history[1]?.sensorA).toBe(65);
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

    expect(history[0]?.sensorB).toBe(65);
    expect(history[1]?.sensorB).toBe(65);
    expect(history[2]?.sensorB).toBe(75);
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

describe("buildSetupVisibleDevices", () => {
  it("marks rediscovered nodes as paired when identity matches an approved rule", () => {
    const devices = buildSetupVisibleDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "address:AA:BB",
            label: "Leg Press",
            peripheralId: null,
            address: "AA:BB",
            localName: "GymMotion-f4e9d4",
            knownDeviceId: null,
          },
        ],
        nodes: [
          {
            id: "known:stack-001",
            label: "Leg Press",
            peripheralId: "peripheral-1",
            address: "AA:BB",
            localName: "GymMotion-f4e9d4",
            knownDeviceId: "stack-001",
            machineLabel: null,
            siteId: null,
            lastRssi: -55,
            lastSeenAt: new Date().toISOString(),
            gatewayConnectionState: "connected",
            isApproved: true,
          },
        ],
      },
      [
        {
          id: "address:AA:BB",
          label: "Leg Press",
          peripheralId: null,
          address: "AA:BB",
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
        },
      ],
    );

    expect(devices[0]?.isPaired).toBe(true);
  });
});

describe("buildPairedDevices", () => {
  it("reuses live runtime connection state for approved nodes", () => {
    const devices = buildPairedDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "stack-001",
            label: "Leg Press",
            peripheralId: "peripheral-1",
            address: null,
            localName: "GymMotion-f4e9d4",
            knownDeviceId: "stack-001",
          },
        ],
        nodes: [],
      },
      {
        liveStatus: "Gateway live",
        trayHint: "Waiting",
        runtimeState: "running",
        gatewayIssue: null,
        gateway: {
          hostname: "test-host",
          mode: "reference-ble-node-gateway",
          sessionId: "session-1",
          adapterState: "poweredOn",
          scanState: "scanning",
          connectedNodeCount: 0,
          reconnectingNodeCount: 1,
          knownNodeCount: 1,
          startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        },
        devices: [
          {
            id: "stack-001",
            lastState: "still",
            lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
            lastDelta: null,
            updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            hardwareId: "hw-1",
            bootId: "boot-1",
            firmwareVersion: "0.5.2",
            machineLabel: "Leg Press",
            siteId: "Dallas",
            provisioningState: "provisioned",
            updateStatus: "idle",
            updateTargetVersion: null,
            updateDetail: null,
            updateUpdatedAt: null,
            lastHeartbeatAt: null,
            lastEventReceivedAt: null,
            healthStatus: "stale",
            gatewayConnectionState: "reconnecting",
            telemetryFreshness: "stale",
            peripheralId: "peripheral-1",
            gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
            gatewayLastDisconnectedAt: new Date("2026-03-14T20:04:30.000Z").toISOString(),
            gatewayLastTelemetryAt: new Date("2026-03-14T20:04:20.000Z").toISOString(),
            gatewayDisconnectReason: "link lost",
            advertisedName: "GymMotion-f4e9d4",
            lastRssi: -61,
            otaStatus: "idle",
            otaTargetVersion: null,
            otaProgressBytesSent: null,
            otaTotalBytes: null,
            otaLastPhase: null,
            otaFailureDetail: null,
            otaLastStatusMessage: null,
            otaUpdatedAt: null,
            reconnectAttempt: 4,
            reconnectAttemptLimit: 20,
            reconnectRetryExhausted: false,
          },
        ],
        events: [],
        logs: [],
        activities: [],
      },
    );

    expect(devices[0]?.connectionState).toBe("reconnecting");
    expect(devices[0]?.name).toBe("Leg Press");
    expect(devices[0]?.macAddress).toBe("peripheral-1");
  });

  it("keeps the saved BLE address instead of a runtime peripheral handle", () => {
    const devices = buildPairedDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "stack-001",
            label: "Leg Press",
            peripheralId: "opaque-winrt-handle",
            address: "AA:BB:CC:DD:EE:FF",
            localName: "GymMotion-f4e9d4",
            knownDeviceId: "stack-001",
          },
        ],
        nodes: [],
      },
      {
        liveStatus: "Gateway live",
        trayHint: "Waiting",
        runtimeState: "running",
        gatewayIssue: null,
        gateway: {
          hostname: "test-host",
          mode: "reference-ble-node-gateway",
          sessionId: "session-1",
          adapterState: "poweredOn",
          scanState: "stopped",
          connectedNodeCount: 1,
          reconnectingNodeCount: 0,
          knownNodeCount: 1,
          startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        },
        devices: [
          {
            id: "stack-001",
            lastState: "still",
            lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
            lastDelta: null,
            updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            hardwareId: "hw-1",
            bootId: "boot-1",
            firmwareVersion: "0.5.2",
            machineLabel: "Leg Press",
            siteId: "Dallas",
            provisioningState: "provisioned",
            updateStatus: "idle",
            updateTargetVersion: null,
            updateDetail: null,
            updateUpdatedAt: null,
            lastHeartbeatAt: null,
            lastEventReceivedAt: null,
            healthStatus: "healthy",
            gatewayConnectionState: "connected",
            telemetryFreshness: "live",
            peripheralId: "opaque-winrt-handle",
            address: "AA:BB:CC:DD:EE:FF",
            gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
            gatewayLastDisconnectedAt: null,
            gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayDisconnectReason: null,
            advertisedName: "GymMotion-f4e9d4",
            lastRssi: -55,
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
          },
        ],
        events: [],
        logs: [],
        activities: [],
      },
    );

    expect(devices[0]?.macAddress).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("matches address-only approved nodes to live runtime state", () => {
    const devices = buildPairedDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "address:AA:BB",
            label: "Leg Press",
            peripheralId: null,
            address: "AA:BB",
            localName: null,
            knownDeviceId: null,
          },
        ],
        nodes: [],
      },
      {
        liveStatus: "Gateway live",
        trayHint: "Waiting",
        runtimeState: "running",
        gatewayIssue: null,
        gateway: {
          hostname: "test-host",
          mode: "reference-ble-node-gateway",
          sessionId: "session-1",
          adapterState: "poweredOn",
          scanState: "scanning",
          connectedNodeCount: 1,
          reconnectingNodeCount: 0,
          knownNodeCount: 1,
          startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        },
        devices: [
          {
            id: "stack-001",
            lastState: "still",
            lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
            lastDelta: null,
            updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            hardwareId: "hw-1",
            bootId: "boot-1",
            firmwareVersion: "0.5.2",
            machineLabel: "Leg Press",
            siteId: "Dallas",
            provisioningState: "provisioned",
            updateStatus: "idle",
            updateTargetVersion: null,
            updateDetail: null,
            updateUpdatedAt: null,
            lastHeartbeatAt: null,
            lastEventReceivedAt: null,
            healthStatus: "healthy",
            gatewayConnectionState: "connected",
            telemetryFreshness: "live",
            peripheralId: null,
            address: "AA:BB",
            gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
            gatewayLastDisconnectedAt: null,
            gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayDisconnectReason: null,
            advertisedName: "GymMotion-f4e9d4",
            lastRssi: -55,
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
          },
        ],
        events: [],
        logs: [],
        activities: [],
      },
    );

    expect(devices[0]?.connectionState).toBe("connected");
    expect(devices[0]?.name).toBe("Leg Press");
    expect(devices[0]?.macAddress).toBe("AA:BB");
  });

  it("prefers the strongest runtime identity over a weaker local-name match", () => {
    const devices = buildPairedDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "known:stack-001",
            label: "Leg Press",
            peripheralId: "peripheral-1",
            address: "AA:BB",
            localName: "GymMotion-f4e9d4",
            knownDeviceId: "stack-001",
          },
        ],
        nodes: [],
      },
      {
        liveStatus: "Gateway live",
        trayHint: "Waiting",
        runtimeState: "running",
        gatewayIssue: null,
        gateway: {
          hostname: "test-host",
          mode: "reference-ble-node-gateway",
          sessionId: "session-1",
          adapterState: "poweredOn",
          scanState: "stopped",
          connectedNodeCount: 1,
          reconnectingNodeCount: 0,
          knownNodeCount: 2,
          startedAt: new Date("2026-03-14T20:00:00.000Z").toISOString(),
          updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
          lastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
        },
        devices: [
          {
            id: "stack-999",
            lastState: "still",
            lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
            lastDelta: null,
            updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            hardwareId: "hw-9",
            bootId: "boot-9",
            firmwareVersion: "0.5.2",
            machineLabel: "Wrong Match",
            siteId: "Dallas",
            provisioningState: "provisioned",
            updateStatus: "idle",
            updateTargetVersion: null,
            updateDetail: null,
            updateUpdatedAt: null,
            lastHeartbeatAt: null,
            lastEventReceivedAt: null,
            healthStatus: "healthy",
            gatewayConnectionState: "connected",
            telemetryFreshness: "live",
            peripheralId: "peripheral-999",
            address: "FF:EE",
            gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
            gatewayLastDisconnectedAt: null,
            gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayDisconnectReason: null,
            advertisedName: "GymMotion-f4e9d4",
            lastRssi: -40,
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
          },
          {
            id: "stack-001",
            lastState: "still",
            lastSeenAt: Date.parse("2026-03-14T20:05:00.000Z"),
            lastDelta: null,
            updatedAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            hardwareId: "hw-1",
            bootId: "boot-1",
            firmwareVersion: "0.5.2",
            machineLabel: "Leg Press",
            siteId: "Dallas",
            provisioningState: "provisioned",
            updateStatus: "idle",
            updateTargetVersion: null,
            updateDetail: null,
            updateUpdatedAt: null,
            lastHeartbeatAt: null,
            lastEventReceivedAt: null,
            healthStatus: "healthy",
            gatewayConnectionState: "reconnecting",
            telemetryFreshness: "live",
            peripheralId: "peripheral-1",
            address: "AA:BB",
            gatewayLastAdvertisementAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
            gatewayLastDisconnectedAt: null,
            gatewayLastTelemetryAt: new Date("2026-03-14T20:05:00.000Z").toISOString(),
            gatewayDisconnectReason: null,
            advertisedName: "GymMotion-f4e9d4",
            lastRssi: -62,
            otaStatus: "idle",
            otaTargetVersion: null,
            otaProgressBytesSent: null,
            otaTotalBytes: null,
            otaLastPhase: null,
            otaFailureDetail: null,
            otaLastStatusMessage: null,
            otaUpdatedAt: null,
            reconnectAttempt: 3,
            reconnectAttemptLimit: 20,
            reconnectRetryExhausted: false,
          },
        ],
        events: [],
        logs: [],
        activities: [],
      },
    );

    expect(devices[0]?.name).toBe("Leg Press");
    expect(devices[0]?.macAddress).toBe("AA:BB");
    expect(devices[0]?.connectionState).toBe("reconnecting");
    expect(devices[0]?.signalStrength).toBe(84);
  });
});
