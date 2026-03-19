import { describe, expect, it } from "vitest";

import { buildDashboardRuntimeStatus } from "./dashboard";
import { buildSetupVisibleDevices } from "./setup";

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
