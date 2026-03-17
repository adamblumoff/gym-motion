import { describe, expect, it } from "bun:test";

import type { ApprovedNodeRule, DiscoveredNodeSummary } from "@core/contracts";
import {
  findMatchingDiscoveredNodeId,
  forgetApprovedNodeRules,
  matchesApprovedNodeIdentity,
  nodeRuleId,
} from "@core/approved-node-runtime-match";

describe("approved-node identity policy", () => {
  it("builds rule ids by strongest available identity first", () => {
    expect(
      nodeRuleId({
        knownDeviceId: "stack-001",
        peripheralId: "peripheral-1",
        address: "AA:BB",
        localName: "GymMotion-f4e9d4",
      }),
    ).toBe("known:stack-001");

    expect(
      nodeRuleId({
        knownDeviceId: null,
        peripheralId: "peripheral-1",
        address: "AA:BB",
        localName: "GymMotion-f4e9d4",
      }),
    ).toBe("peripheral:peripheral-1");
  });

  it("matches addresses case-insensitively", () => {
    const rule: ApprovedNodeRule = {
      id: "address:AA:BB",
      label: "Bench",
      knownDeviceId: null,
      peripheralId: null,
      address: "AA:BB",
      localName: null,
    };

    expect(
      matchesApprovedNodeIdentity(rule, {
        knownDeviceId: null,
        peripheralId: null,
        address: "aa:bb",
        localName: null,
      }),
    ).toBe(true);
  });

  it("does not use shared local names as approval proof", () => {
    const approvedNodes: ApprovedNodeRule[] = [
      {
        id: "name:GymMotion-f4e9d4-a",
        label: "Bench A",
        knownDeviceId: null,
        peripheralId: null,
        address: null,
        localName: "GymMotion-f4e9d4",
      },
      {
        id: "name:GymMotion-f4e9d4-b",
        label: "Bench B",
        knownDeviceId: null,
        peripheralId: null,
        address: null,
        localName: "GymMotion-f4e9d4",
      },
    ];

    expect(
      matchesApprovedNodeIdentity(
        approvedNodes[0],
        {
          knownDeviceId: null,
          peripheralId: null,
          address: null,
          localName: "GymMotion-f4e9d4",
        },
        approvedNodes,
      ),
    ).toBe(false);
  });

  it("finds matching setup rows using the shared rule engine", () => {
    const approvedNode: ApprovedNodeRule = {
      id: "name:GymMotion-f4e9d4",
      label: "Bench",
      knownDeviceId: null,
      peripheralId: null,
      address: null,
      localName: "GymMotion-f4e9d4",
    };
    const nodesById = new Map<string, DiscoveredNodeSummary>([
      [
        "peripheral:peripheral-1",
        {
          id: "peripheral:peripheral-1",
          label: "Visible node",
          peripheralId: "peripheral-1",
          address: "AA:BB",
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
          machineLabel: null,
          siteId: null,
          lastRssi: -58,
          lastSeenAt: null,
          gatewayConnectionState: "visible",
          isApproved: false,
        },
      ],
    ]);

    expect(findMatchingDiscoveredNodeId(nodesById, approvedNode, [approvedNode])).toBe(
      "peripheral:peripheral-1",
    );
  });

  it("forgets approved nodes by address regardless of casing", () => {
    const approvedNodes: ApprovedNodeRule[] = [
      {
        id: "address:AA:BB",
        label: "Bench",
        knownDeviceId: null,
        peripheralId: null,
        address: "AA:BB",
        localName: null,
      },
    ];

    expect(
      forgetApprovedNodeRules(approvedNodes, {
        id: null,
        knownDeviceId: null,
        peripheralId: null,
        address: "aa:bb",
        localName: null,
      }),
    ).toEqual([]);
  });
});
