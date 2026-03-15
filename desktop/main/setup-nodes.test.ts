import { describe, expect, it } from "bun:test";

import type { ApprovedNodeRule, DiscoveredNodeSummary } from "@core/contracts";

import { hasApprovedSetupNode, matchingApprovedSetupNodeId } from "./setup-nodes";

describe("setup nodes helpers", () => {
  it("does not collapse distinct approved nodes that share fuzzy identity fields", () => {
    const nodesById = new Map<string, DiscoveredNodeSummary>([
      [
        "known:stack-001",
        {
          id: "known:stack-001",
          label: "GymMotion",
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
    ]);

    const secondApprovedNode: ApprovedNodeRule = {
      id: "known:stack-002",
      label: "GymMotion",
      peripheralId: "peripheral-2",
      address: "CC:DD",
      localName: "GymMotion-f4e9d4",
      knownDeviceId: "stack-002",
    };

    expect(hasApprovedSetupNode(nodesById, secondApprovedNode)).toBe(false);
  });

  it("folds rediscovered rebooted nodes back into the approved entry", () => {
    const nodesById = new Map<string, DiscoveredNodeSummary>([
      [
        "peripheral:new-peripheral",
        {
          id: "peripheral:new-peripheral",
          label: "GymMotion",
          peripheralId: "new-peripheral",
          address: null,
          localName: "GymMotion-f4e9d4",
          knownDeviceId: "stack-001",
          machineLabel: "Leg Press",
          siteId: null,
          lastRssi: -55,
          lastSeenAt: new Date().toISOString(),
          gatewayConnectionState: "reconnecting",
          isApproved: true,
        },
      ],
    ]);

    const approvedNode: ApprovedNodeRule = {
      id: "known:stack-001",
      label: "Leg Press",
      peripheralId: "old-peripheral",
      address: null,
      localName: "GymMotion-f4e9d4",
      knownDeviceId: "stack-001",
    };

    expect(matchingApprovedSetupNodeId(nodesById, approvedNode)).toBe("peripheral:new-peripheral");
    expect(hasApprovedSetupNode(nodesById, approvedNode)).toBe(true);
  });

  it("matches approved setup nodes by address case-insensitively", () => {
    const nodesById = new Map<string, DiscoveredNodeSummary>([
      [
        "peripheral:new-peripheral",
        {
          id: "peripheral:new-peripheral",
          label: "GymMotion",
          peripheralId: null,
          address: "AA:BB",
          localName: null,
          knownDeviceId: null,
          machineLabel: null,
          siteId: null,
          lastRssi: -55,
          lastSeenAt: new Date().toISOString(),
          gatewayConnectionState: "reconnecting",
          isApproved: true,
        },
      ],
    ]);

    const approvedNode: ApprovedNodeRule = {
      id: "address:aa:bb",
      label: "Leg Press",
      peripheralId: null,
      address: "aa:bb",
      localName: null,
      knownDeviceId: null,
    };

    expect(matchingApprovedSetupNodeId(nodesById, approvedNode)).toBe("peripheral:new-peripheral");
    expect(hasApprovedSetupNode(nodesById, approvedNode)).toBe(true);
  });

  it("matches approved setup nodes by local name when that is the only saved identity", () => {
    const nodesById = new Map<string, DiscoveredNodeSummary>([
      [
        "peripheral:new-peripheral",
        {
          id: "peripheral:new-peripheral",
          label: "GymMotion",
          peripheralId: null,
          address: null,
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
          machineLabel: null,
          siteId: null,
          lastRssi: -55,
          lastSeenAt: new Date().toISOString(),
          gatewayConnectionState: "reconnecting",
          isApproved: true,
        },
      ],
    ]);

    const approvedNode: ApprovedNodeRule = {
      id: "name:GymMotion-f4e9d4",
      label: "Leg Press",
      peripheralId: null,
      address: null,
      localName: "GymMotion-f4e9d4",
      knownDeviceId: null,
    };

    expect(matchingApprovedSetupNodeId(nodesById, approvedNode)).toBe("peripheral:new-peripheral");
    expect(hasApprovedSetupNode(nodesById, approvedNode)).toBe(true);
  });
});
