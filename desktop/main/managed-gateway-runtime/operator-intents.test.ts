import { describe, expect, it } from "bun:test";

import type { DesktopSetupState } from "@core/contracts";

import { createOperatorIntents } from "./operator-intents";

function createSetupState(
  overrides: Partial<DesktopSetupState> = {},
): DesktopSetupState {
  return {
    adapterIssue: null,
    approvedNodes: [],
    manualScanState: "idle",
    pairingCandidateId: null,
    manualScanError: null,
    manualCandidates: [],
    ...overrides,
  };
}

describe("operator-intents", () => {
  it("starts a Windows manual scan by requesting a runtime restart when the sidecar is down", async () => {
    let setupState = createSetupState();
    const manualScanPayloads: Array<Partial<DesktopSetupState>> = [];
    let restartCount = 0;
    let windowsScanRequested = false;

    const intents = createOperatorIntents({
      getSetupState: () => setupState,
      setSetupState: (nextSetup) => {
        setupState = nextSetup;
      },
      emitSetup: () => {},
      getChild: () => null,
      refreshAdapters: async () => {},
      dispatchGatewayCommand: async () => {},
      sendGatewayCommand: async () => {},
      restartRuntime: async () => {
        restartCount += 1;
      },
      manualCandidateById: () => null,
      persistApprovedNodes: (nextNodes) => nextNodes,
      runtimeDeviceById: () => null,
      resolveApprovedRuleIdForNode: () => null,
      applyManualScanPayload: (payload) => {
        manualScanPayloads.push(payload);
        setupState = {
          ...setupState,
          manualScanState: payload.state ?? setupState.manualScanState,
          pairingCandidateId: payload.pairingCandidateId ?? null,
          manualScanError: payload.error ?? null,
          manualCandidates: payload.candidates ?? setupState.manualCandidates,
        };
      },
      setWindowsScanRequested: (requested) => {
        windowsScanRequested = requested;
      },
    });

    const nextSetup = await intents.startManualScan();

    expect(windowsScanRequested).toBe(true);
    expect(restartCount).toBe(1);
    expect(manualScanPayloads).toEqual([
      {
        state: "scanning",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      },
    ]);
    expect(nextSetup.manualScanState).toBe("scanning");
  });

  it("surfaces immediate child-backed manual scan dispatch failures", async () => {
    let setupState = createSetupState();
    const manualScanPayloads: Array<Partial<DesktopSetupState>> = [];

    const intents = createOperatorIntents({
      getSetupState: () => setupState,
      setSetupState: (nextSetup) => {
        setupState = nextSetup;
      },
      emitSetup: () => {},
      getChild: () => ({}),
      refreshAdapters: async () => {},
      dispatchGatewayCommand: async () => {
        throw new Error("Gateway runtime is not running.");
      },
      sendGatewayCommand: async () => {},
      restartRuntime: async () => {},
      manualCandidateById: () => null,
      persistApprovedNodes: (nextNodes) => nextNodes,
      runtimeDeviceById: () => null,
      resolveApprovedRuleIdForNode: () => null,
      applyManualScanPayload: (payload) => {
        manualScanPayloads.push(payload);
      },
      setWindowsScanRequested: () => {},
    });

    await expect(intents.startManualScan()).rejects.toThrow("Gateway runtime is not running.");
    expect(manualScanPayloads).toEqual([]);
    expect(setupState.manualScanState).toBe("idle");
  });
});
