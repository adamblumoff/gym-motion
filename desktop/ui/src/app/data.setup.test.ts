import { describe, expect, it } from "bun:test";

import { buildDashboardRuntimeStatus } from "./selectors/dashboard";
import { buildPairedDevices, buildSetupVisibleDevices } from "./selectors/setup";

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
        manualScanState: "scanning",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [
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

  it("keeps ambiguous shared-name discoveries visible as unpaired", () => {
    const devices = buildSetupVisibleDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "name:GymMotion-f4e9d4-a",
            label: "Leg Press A",
            peripheralId: null,
            address: null,
            localName: "GymMotion-f4e9d4",
            knownDeviceId: null,
          },
          {
            id: "name:GymMotion-f4e9d4-b",
            label: "Leg Press B",
            peripheralId: null,
            address: null,
            localName: "GymMotion-f4e9d4",
            knownDeviceId: null,
          },
        ],
        manualScanState: "scanning",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [
          {
            id: "peripheral:peripheral-2",
            label: "GymMotion-f4e9d4",
            peripheralId: "peripheral-2",
            address: "CC:DD",
            localName: "GymMotion-f4e9d4",
            knownDeviceId: null,
            machineLabel: null,
            siteId: null,
            lastRssi: -61,
            lastSeenAt: new Date().toISOString(),
          },
        ],
      },
      [
        {
          id: "name:GymMotion-f4e9d4-a",
          label: "Leg Press A",
          peripheralId: null,
          address: null,
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
        },
        {
          id: "name:GymMotion-f4e9d4-b",
          label: "Leg Press B",
          peripheralId: null,
          address: null,
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
        },
      ],
    );

    expect(devices[0]?.isPaired).toBe(false);
  });
});

describe("buildDashboardRuntimeStatus", () => {
  it("shows waiting when no approved nodes remain in the filtered dashboard", () => {
    expect(buildDashboardRuntimeStatus(0)).toBe("Waiting for BLE nodes");
  });

  it("shows gateway live once at least one approved node remains", () => {
    expect(buildDashboardRuntimeStatus(1)).toBe("Gateway live");
    expect(buildDashboardRuntimeStatus(3)).toBe("Gateway live");
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
        manualScanState: "idle",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [],
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
    expect(devices[0]?.lastDisconnectReason).toBeNull();
    expect(devices[0]?.reconnectAttempt).toBe(4);
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
        manualScanState: "idle",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [],
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
        manualScanState: "idle",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [],
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
        manualScanState: "idle",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [],
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

  it("hides disconnect reasons while a paired node is already reconnecting", () => {
    const devices = buildPairedDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "known:stack-001",
            label: "Leg Press",
            peripheralId: "peripheral-1",
            address: "AA:BB:CC:DD",
            localName: "GymMotion-f4e9d4",
            knownDeviceId: "stack-001",
          },
        ],
        manualScanState: "idle",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [],
      },
      {
        liveStatus: "Waiting for approved BLE nodes",
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
            healthStatus: "offline",
            gatewayConnectionState: "reconnecting",
            telemetryFreshness: "missing",
            peripheralId: "peripheral-1",
            address: "AA:BB:CC:DD",
            gatewayLastAdvertisementAt: null,
            gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
            gatewayLastDisconnectedAt: new Date("2026-03-14T20:05:05.000Z").toISOString(),
            gatewayLastTelemetryAt: null,
            gatewayDisconnectReason: "manual recovery failed: app-session lease step failed",
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
            reconnectAttempt: 1,
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
    expect(devices[0]?.lastDisconnectReason).toBeNull();
  });

  it("surfaces disconnect reasons and recovery metadata for paired nodes", () => {
    const devices = buildPairedDevices(
      {
        adapterIssue: null,
        approvedNodes: [
          {
            id: "known:stack-001",
            label: "Leg Press",
            peripheralId: "peripheral-1",
            address: "AA:BB:CC:DD",
            localName: "GymMotion-f4e9d4",
            knownDeviceId: "stack-001",
          },
        ],
        manualScanState: "idle",
        pairingCandidateId: null,
        manualScanError: null,
        manualCandidates: [],
      },
      {
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
            healthStatus: "offline",
            gatewayConnectionState: "disconnected",
            telemetryFreshness: "missing",
            peripheralId: "peripheral-1",
            address: "AA:BB:CC:DD",
            gatewayLastAdvertisementAt: null,
            gatewayLastConnectedAt: new Date("2026-03-14T20:04:00.000Z").toISOString(),
            gatewayLastDisconnectedAt: new Date("2026-03-14T20:05:05.000Z").toISOString(),
            gatewayLastTelemetryAt: null,
            gatewayDisconnectReason: "manual recovery failed: app-session lease step failed",
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
            reconnectAttempt: 1,
            reconnectAttemptLimit: 20,
            reconnectRetryExhausted: false,
          },
        ],
        events: [],
        logs: [],
        activities: [],
      },
    );

    expect(devices[0]?.lastDisconnectReason).toContain("manual recovery failed");
    expect(devices[0]?.reconnectAttempt).toBe(1);
    expect(devices[0]?.reconnectRetryExhausted).toBe(false);
  });
});
