import { describe, expect, it } from "bun:test";

import type { DesktopSetupState } from "@core/contracts";

import {
  buildApprovedNodeRules,
  forgetApprovedNodeRules,
  matchesApprovedNodeIdentity,
  resolveVisibleNodes,
} from "./setup-rules";

function createSetupState(): DesktopSetupState {
  return {
    adapterIssue: null,
    approvedNodes: [
      {
        id: "known:stack-001",
        label: "Stack 001",
        peripheralId: "p-1",
        address: "AA:BB",
        localName: "Gym Motion 1",
        knownDeviceId: "stack-001",
      },
    ],
    nodes: [],
  };
}

describe("setup-rules", () => {
  it("falls back to approved nodes when no live discoveries exist", () => {
    const visibleNodes = resolveVisibleNodes(createSetupState());

    expect(visibleNodes).toHaveLength(1);
    expect(visibleNodes[0]?.id).toBe("known:stack-001");
    expect(visibleNodes[0]?.gatewayConnectionState).toBe("visible");
  });

  it("builds allowed node rules from visible nodes first", () => {
    const setup = createSetupState();
    setup.nodes = [
      {
        id: "known:stack-001",
        label: "Visible Stack 001",
        peripheralId: "p-1",
        address: "AA:BB",
        localName: "Gym Motion 1",
        knownDeviceId: "stack-001",
        machineLabel: "Press 1",
        siteId: "west",
        lastRssi: -58,
        lastSeenAt: new Date().toISOString(),
        gatewayConnectionState: "connected",
        isApproved: true,
      },
    ];

    const rules = buildApprovedNodeRules(setup, ["known:stack-001"]);

    expect(rules).toEqual([
      {
        id: "known:stack-001",
        label: "Visible Stack 001",
        peripheralId: "p-1",
        address: "AA:BB",
        localName: "Gym Motion 1",
        knownDeviceId: "stack-001",
      },
    ]);
  });

  it("forgets approved nodes by runtime device id", () => {
    const setup = createSetupState();

    expect(forgetApprovedNodeRules(setup.approvedNodes, "stack-001")).toEqual([]);
  });

  it("matches approved nodes by identity fields, not only exact ids", () => {
    const [rule] = createSetupState().approvedNodes;

    expect(
      matchesApprovedNodeIdentity(rule, {
        peripheralId: null,
        address: "AA:BB",
        localName: null,
        knownDeviceId: null,
      }),
    ).toBe(true);
  });
});
