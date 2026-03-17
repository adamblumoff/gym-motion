import { describe, expect, it } from "bun:test";

import { approvedNodeRulesReferToSamePhysicalNode } from "./windows-winrt-gateway-node.mjs";

describe("approvedNodeRulesReferToSamePhysicalNode", () => {
  it("treats a provisional manual-scan rule and canonical known-device rule as the same node", () => {
    expect(
      approvedNodeRulesReferToSamePhysicalNode(
        {
          id: "peripheral:D4:E9:F4:B2:5A:0A",
          label: "GymMotion-f4e9d4",
          peripheralId: "D4:E9:F4:B2:5A:0A",
          address: "D4:E9:F4:B2:5A:0A",
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
        },
        {
          id: "known:esp32-085ab2f4e9d4",
          label: "Leg Press",
          peripheralId: "D4:E9:F4:B2:5A:0A",
          address: "D4:E9:F4:B2:5A:0A",
          localName: "GymMotion-f4e9d4",
          knownDeviceId: "esp32-085ab2f4e9d4",
        },
      ),
    ).toBe(true);
  });

  it("does not collapse distinct nodes that only share a display name", () => {
    expect(
      approvedNodeRulesReferToSamePhysicalNode(
        {
          id: "peripheral:aa",
          label: "GymMotion-f4e9d4",
          peripheralId: "AA",
          address: "AA",
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
        },
        {
          id: "peripheral:bb",
          label: "GymMotion-f4e9d4",
          peripheralId: "BB",
          address: "BB",
          localName: "GymMotion-f4e9d4",
          knownDeviceId: null,
        },
      ),
    ).toBe(false);
  });
});
