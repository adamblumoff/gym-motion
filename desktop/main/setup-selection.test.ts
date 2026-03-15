import { describe, expect, it } from "bun:test";

import {
  createApprovedNodeRule,
  findMatchingGatewayDeviceForApprovedNode,
  matchesApprovedNodeRule,
  nodeRuleId,
  reconcileApprovedNodeRule,
} from "./setup-selection";

describe("setup selection helpers", () => {
  it("builds a stable id from known device ids before discovery identifiers", () => {
    expect(
      nodeRuleId({
        knownDeviceId: "stack-001",
        peripheralId: "peripheral-1",
        address: "00:11:22:33:44:55",
        localName: "GymMotion-1",
      }),
    ).toBe("known:stack-001");
  });

  it("matches approved rules against any available discovery identity", () => {
    const rule = createApprovedNodeRule({
      label: "GymMotion-1",
      peripheralId: "peripheral-1",
      address: "00:11:22:33:44:55",
      localName: "GymMotion-1",
      knownDeviceId: null,
    });

    expect(
      matchesApprovedNodeRule(rule, {
        knownDeviceId: null,
        peripheralId: "peripheral-1",
        address: null,
        localName: null,
      }),
    ).toBe(true);
    expect(
      matchesApprovedNodeRule(rule, {
        knownDeviceId: null,
        peripheralId: null,
        address: "00:11:22:33:44:55",
        localName: null,
      }),
    ).toBe(true);
  });

  it("prefers a stable runtime device match for approved reboot recovery", () => {
    const device = findMatchingGatewayDeviceForApprovedNode(
      {
        id: "peripheral:peripheral-1",
        label: "Leg Press",
        peripheralId: "peripheral-1",
        address: null,
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
      [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: 0,
          lastDelta: null,
          updatedAt: new Date().toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-2",
          firmwareVersion: "0.5.2",
          machineLabel: "Leg Press",
          siteId: null,
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
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: null,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: null,
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -60,
          otaStatus: "idle",
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
        },
      ],
    );

    expect(device?.id).toBe("stack-001");
  });

  it("upgrades approved nodes to known device ids after runtime identity resolves", () => {
    const reconciled = reconcileApprovedNodeRule(
      {
        id: "peripheral:peripheral-1",
        label: "Bench Sensor",
        peripheralId: "peripheral-1",
        address: null,
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
      [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: 0,
          lastDelta: null,
          updatedAt: new Date().toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-2",
          firmwareVersion: "0.5.2",
          machineLabel: "Leg Press",
          siteId: null,
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
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: null,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: null,
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -60,
          otaStatus: "idle",
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
        },
      ],
    );

    expect(reconciled.id).toBe("known:stack-001");
    expect(reconciled.knownDeviceId).toBe("stack-001");
    expect(reconciled.label).toBe("Leg Press");
  });

  it("upgrades address-only approved nodes after reconnect identity resolves", () => {
    const reconciled = reconcileApprovedNodeRule(
      {
        id: "address:AA:BB:CC:DD",
        label: "Bench Sensor",
        peripheralId: null,
        address: "AA:BB:CC:DD",
        localName: null,
        knownDeviceId: null,
      },
      [
        {
          id: "stack-001",
          lastState: "still",
          lastSeenAt: 0,
          lastDelta: null,
          updatedAt: new Date().toISOString(),
          hardwareId: "hw-1",
          bootId: "boot-2",
          firmwareVersion: "0.5.2",
          machineLabel: "Leg Press",
          siteId: null,
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
          peripheralId: null,
          address: "AA:BB:CC:DD",
          gatewayLastAdvertisementAt: null,
          gatewayLastConnectedAt: null,
          gatewayLastDisconnectedAt: null,
          gatewayLastTelemetryAt: null,
          gatewayDisconnectReason: null,
          advertisedName: "GymMotion-f4e9d4",
          lastRssi: -60,
          otaStatus: "idle",
          otaTargetVersion: null,
          otaProgressBytesSent: null,
          otaTotalBytes: null,
          otaLastPhase: null,
          otaFailureDetail: null,
          otaLastStatusMessage: null,
          otaUpdatedAt: null,
        },
      ],
    );

    expect(reconciled.id).toBe("known:stack-001");
    expect(reconciled.knownDeviceId).toBe("stack-001");
    expect(reconciled.address).toBe("AA:BB:CC:DD");
  });
});
