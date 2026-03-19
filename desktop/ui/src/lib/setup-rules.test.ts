import { describe, expect, it } from "vitest";

import type { DesktopSetupState } from "@core/contracts";

import {
  buildApprovedNodeRules,
  forgetApprovedNodeRules,
  matchesApprovedNodeIdentity,
  resolveApprovedNodeRuleId,
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
    manualScanState: "idle",
    pairingCandidateId: null,
    manualScanError: null,
    manualCandidates: [],
  };
}

describe("setup-rules", () => {
  it("returns no visible candidates when no manual scan results exist", () => {
    const visibleNodes = resolveVisibleNodes(createSetupState());

    expect(visibleNodes).toEqual([]);
  });

  it("builds allowed node rules from visible nodes first", () => {
    const setup = createSetupState();
    setup.manualCandidates = [
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

  it("forgets approved nodes by runtime identity fields from the dashboard", () => {
    const approvedNodes: DesktopSetupState["approvedNodes"] = [
      {
        id: "address:AA:BB",
        label: "Stack 001",
        peripheralId: null,
        address: "AA:BB",
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
    ];

    expect(
      forgetApprovedNodeRules(approvedNodes, {
        id: "stack-001",
        knownDeviceId: "stack-001",
        peripheralId: "peripheral-1",
        address: "AA:BB",
        localName: "GymMotion-f4e9d4",
      }),
    ).toEqual([]);
  });

  it("does not forget unrelated approved nodes that only share null identity fields", () => {
    const approvedNodes: DesktopSetupState["approvedNodes"] = [
      {
        id: "known:stack-001",
        label: "Stack 001",
        peripheralId: "peripheral-1",
        address: null,
        localName: null,
        knownDeviceId: "stack-001",
      },
      {
        id: "known:stack-002",
        label: "Stack 002",
        peripheralId: "peripheral-2",
        address: null,
        localName: null,
        knownDeviceId: "stack-002",
      },
    ];

    expect(
      forgetApprovedNodeRules(approvedNodes, {
        id: "stack-001",
        knownDeviceId: "stack-001",
        peripheralId: "peripheral-1",
        address: null,
        localName: null,
      }),
    ).toEqual([approvedNodes[1]!]);
  });

  it("does not forget every approved node that only shares a local name", () => {
    const approvedNodes: DesktopSetupState["approvedNodes"] = [
      {
        id: "name:GymMotion-f4e9d4-a",
        label: "Stack 001",
        peripheralId: null,
        address: null,
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
      {
        id: "name:GymMotion-f4e9d4-b",
        label: "Stack 002",
        peripheralId: null,
        address: null,
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
    ];

    expect(
      forgetApprovedNodeRules(approvedNodes, {
        id: "stack-001",
        knownDeviceId: null,
        peripheralId: null,
        address: null,
        localName: "GymMotion-f4e9d4",
      }),
    ).toEqual(approvedNodes);
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

  it("matches approved node addresses case-insensitively", () => {
    const [rule] = createSetupState().approvedNodes;

    expect(
      matchesApprovedNodeIdentity(rule, {
        peripheralId: null,
        address: "aa:bb",
        localName: null,
        knownDeviceId: null,
      }),
    ).toBe(true);
  });

  it("resolves a newly paired rule id from visible node identity", () => {
    const setup = createSetupState();
    setup.manualCandidates = [
      {
        id: "visible:001",
        label: "Visible Stack 001",
        peripheralId: "p-1",
        address: "AA:BB",
        localName: "Gym Motion 1",
        knownDeviceId: "stack-001",
        machineLabel: null,
        siteId: null,
        lastRssi: -62,
        lastSeenAt: new Date().toISOString(),
      },
    ];

    const rules = buildApprovedNodeRules(setup, ["visible:001"]);

    expect(
      resolveApprovedNodeRuleId(rules, {
        fallbackId: "visible:001",
        peripheralId: "p-1",
        address: "AA:BB",
        localName: "Gym Motion 1",
        knownDeviceId: "stack-001",
      }),
    ).toBe("visible:001");
  });

  it("does not treat shared local names as proof a visible node is already paired", () => {
    const approvedNodes: DesktopSetupState["approvedNodes"] = [
      {
        id: "name:GymMotion-f4e9d4-a",
        label: "Stack 001",
        peripheralId: null,
        address: null,
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
      {
        id: "name:GymMotion-f4e9d4-b",
        label: "Stack 002",
        peripheralId: null,
        address: null,
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
    ];

    expect(
      matchesApprovedNodeIdentity(
        approvedNodes[0]!,
        {
          peripheralId: null,
          address: null,
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
        },
        approvedNodes,
      ),
    ).toBe(false);
  });

  it("resolves keep-device actions to the matching approved rule id", () => {
    const approvedNodes: DesktopSetupState["approvedNodes"] = [
      {
        id: "address:AA:BB",
        label: "Stack 001",
        peripheralId: null,
        address: "AA:BB",
        localName: "GymMotion-f4e9d4",
        knownDeviceId: null,
      },
    ];

    expect(
      resolveApprovedNodeRuleId(approvedNodes, {
        fallbackId: "stack-001",
        knownDeviceId: "stack-001",
        peripheralId: "peripheral-1",
        address: "AA:BB",
        localName: "GymMotion-f4e9d4",
      }),
    ).toBe("address:AA:BB");
  });
});
