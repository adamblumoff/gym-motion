import { describe, expect, it } from "bun:test";

import type { ApprovedNodeRule, DiscoveredNodeSummary } from "@core/contracts";

import { hasApprovedSetupNode } from "./setup-nodes";

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
});
