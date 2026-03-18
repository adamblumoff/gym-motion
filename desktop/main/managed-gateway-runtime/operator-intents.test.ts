import { describe, expect, it } from "bun:test";

import type {
  ApprovedNodeRule,
  DesktopSetupState,
  GatewayRuntimeDeviceSummary,
  ManualScanCandidateSummary,
} from "@core/contracts";

import { createOperatorIntents } from "./operator-intents";

function createCandidate(
  overrides: Partial<ManualScanCandidateSummary> = {},
): ManualScanCandidateSummary {
  return {
    id: "candidate-1",
    label: "Front Rack Sensor",
    peripheralId: "peripheral-1",
    address: "AA:BB:CC:DD",
    localName: "GymMotion-front",
    knownDeviceId: "known-1",
    machineLabel: null,
    siteId: null,
    lastRssi: -58,
    lastSeenAt: "2026-03-16T10:00:00.000Z",
    ...overrides,
  };
}

function createApprovedNode(
  overrides: Partial<ApprovedNodeRule> = {},
): ApprovedNodeRule {
  return {
    id: "rule-1",
    label: "Front Rack Sensor",
    peripheralId: "peripheral-1",
    address: "AA:BB:CC:DD",
    localName: "GymMotion-front",
    knownDeviceId: "known-1",
    ...overrides,
  };
}

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

function createRuntimeDevice(
  overrides: Partial<GatewayRuntimeDeviceSummary> = {},
): GatewayRuntimeDeviceSummary {
  return {
    id: "runtime-1",
    lastState: "still",
    lastSeenAt: Date.now(),
    lastDelta: null,
    updatedAt: "2026-03-16T10:00:00.000Z",
    hardwareId: "hw-1",
    bootId: "boot-1",
    firmwareVersion: "0.6.0",
    machineLabel: null,
    siteId: null,
    provisioningState: "provisioned",
    updateStatus: "idle",
    updateTargetVersion: null,
    updateDetail: null,
    updateUpdatedAt: null,
    lastHeartbeatAt: null,
    lastEventReceivedAt: "2026-03-16T10:00:00.000Z",
    healthStatus: "online",
    gatewayConnectionState: "disconnected",
    telemetryFreshness: "fresh",
    peripheralId: "peripheral-1",
    address: "AA:BB:CC:DD",
    gatewayLastAdvertisementAt: null,
    gatewayLastConnectedAt: null,
    gatewayLastDisconnectedAt: null,
    gatewayLastTelemetryAt: null,
    gatewayDisconnectReason: "Signal lost",
    advertisedName: "GymMotion-front",
    lastRssi: -62,
    otaStatus: "idle",
    otaTargetVersion: null,
    otaProgressBytesSent: null,
    otaTotalBytes: null,
    otaLastPhase: null,
    otaFailureDetail: null,
    otaLastStatusMessage: null,
    otaUpdatedAt: null,
    reconnectAttempt: 0,
    reconnectAttemptLimit: 20,
    reconnectRetryExhausted: false,
    reconnectAwaitingDecision: false,
    ...overrides,
  };
}

describe("operator-intents", () => {
  it("pairs a discovered node through the Windows runtime intent flow", async () => {
    let setupState = createSetupState({
      manualCandidates: [createCandidate()],
    });
    const commands: Record<string, unknown>[] = [];
    let emittedSetupCount = 0;

    const intents = createOperatorIntents({
      getSetupState: () => setupState,
      setSetupState: (nextSetup) => {
        setupState = nextSetup;
      },
      emitSetup: () => {
        emittedSetupCount += 1;
      },
      getChild: () => ({}),
      refreshAdapters: async () => {},
      sendGatewayCommand: async (command) => {
        commands.push(command);
      },
      restartRuntime: async () => {},
      manualCandidateById: (candidateId) =>
        setupState.manualCandidates.find((candidate) => candidate.id === candidateId) ?? null,
      persistApprovedNodes: (nextNodes) => {
        setupState = {
          ...setupState,
          approvedNodes: nextNodes,
        };
        return nextNodes;
      },
      runtimeDeviceById: () => null,
      resolveApprovedRuleIdForNode: () => null,
      applyManualScanPayload: () => {},
      setWindowsScanRequested: () => {},
    });

    const nextSetup = await intents.pairDiscoveredNode("candidate-1");

    expect(nextSetup.approvedNodes).toEqual([
      createApprovedNode({
        id: "candidate-1",
      }),
    ]);
    expect(nextSetup.manualScanState).toBe("pairing");
    expect(nextSetup.pairingCandidateId).toBe("candidate-1");
    expect(emittedSetupCount).toBe(1);
    expect(commands).toEqual([
      {
        type: "set_allowed_nodes",
        nodes: nextSetup.approvedNodes,
      },
      {
        type: "pair_manual_candidate",
        candidateId: "candidate-1",
      },
    ]);
  });

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

  it("waits for child-confirmed scan state when the sidecar is running", async () => {
    let setupState = createSetupState();
    const manualScanPayloads: Array<Partial<DesktopSetupState>> = [];
    const commands: Record<string, unknown>[] = [];

    const intents = createOperatorIntents({
      getSetupState: () => setupState,
      setSetupState: (nextSetup) => {
        setupState = nextSetup;
      },
      emitSetup: () => {},
      getChild: () => ({}),
      refreshAdapters: async () => {},
      sendGatewayCommand: async (command) => {
        commands.push(command);
      },
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

    const nextSetup = await intents.startManualScan();

    expect(commands).toEqual([{ type: "start_manual_scan" }]);
    expect(manualScanPayloads).toEqual([]);
    expect(nextSetup.manualScanState).toBe("idle");
  });

  it("clears scan state when a child-backed manual scan command fails", async () => {
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
      sendGatewayCommand: async () => {
        throw new Error("Gateway command timed out: start_manual_scan.");
      },
      restartRuntime: async () => {},
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
      setWindowsScanRequested: () => {},
    });

    await expect(intents.startManualScan()).rejects.toThrow(
      "Gateway command timed out: start_manual_scan.",
    );
    expect(manualScanPayloads).toEqual([
      {
        state: "failed",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      },
    ]);
    expect(setupState.manualScanState).toBe("failed");
    expect(setupState.pairingCandidateId).toBeNull();
    expect(setupState.manualCandidates).toEqual([]);
  });

  it("forgets a runtime-backed node, syncs the remaining approved set, and clears stale scan state", async () => {
    let setupState = createSetupState({
      approvedNodes: [
        createApprovedNode({
          id: "rule-1",
        }),
      ],
      manualScanState: "pairing",
      pairingCandidateId: "candidate-1",
      manualScanError: "Old error",
      manualCandidates: [createCandidate()],
    });
    const commands: Record<string, unknown>[] = [];
    const manualScanPayloads: Array<Partial<DesktopSetupState>> = [];
    let refreshAdaptersCount = 0;

    const intents = createOperatorIntents({
      getSetupState: () => setupState,
      setSetupState: (nextSetup) => {
        setupState = nextSetup;
      },
      emitSetup: () => {},
      getChild: () => ({}),
      refreshAdapters: async () => {
        refreshAdaptersCount += 1;
      },
      sendGatewayCommand: async (command) => {
        commands.push(command);
      },
      restartRuntime: async () => {},
      manualCandidateById: () => null,
      persistApprovedNodes: (nextNodes) => {
        setupState = {
          ...setupState,
          approvedNodes: nextNodes,
        };
        return nextNodes;
      },
      runtimeDeviceById: (nodeId) =>
        nodeId === "runtime-1" ? createRuntimeDevice({ id: "runtime-1" }) : null,
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
      setWindowsScanRequested: () => {},
    });

    const nextSetup = await intents.forgetNode("rule-1");

    expect(nextSetup.approvedNodes).toEqual([]);
    expect(nextSetup.manualScanState).toBe("idle");
    expect(nextSetup.pairingCandidateId).toBeNull();
    expect(nextSetup.manualScanError).toBeNull();
    expect(nextSetup.manualCandidates).toEqual([]);
    expect(refreshAdaptersCount).toBe(1);
    expect(commands).toEqual([
      {
        type: "set_allowed_nodes",
        nodes: [],
      },
    ]);
    expect(manualScanPayloads).toEqual([
      {
        state: "idle",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      },
    ]);
  });
});
