import { describe, expect, it } from "bun:test";

import {
  createApprovedNodeRule,
  matchesApprovedNodeRule,
  nodeRuleId,
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
});
