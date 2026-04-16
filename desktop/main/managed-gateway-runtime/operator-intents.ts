import type {
  ApprovedNodeRule,
  DesktopSetupState,
  GatewayRuntimeDeviceSummary,
} from "@core/contracts";

import { forgetApprovedNodeRules } from "../setup-selection";
import type {
  GatewayControlCommand,
  GatewayControlCommandResult,
} from "./gateway-child-ipc";

type OperatorIntentDeps = {
  getSetupState: () => DesktopSetupState;
  setSetupState: (setup: DesktopSetupState) => void;
  emitSetup: () => void;
  getChild: () => { killed?: boolean } | null;
  refreshAdapters: () => Promise<void>;
  sendGatewayCommand: <TCommand extends GatewayControlCommand>(
    command: TCommand,
  ) => Promise<GatewayControlCommandResult<TCommand>>;
  restartRuntime: () => Promise<unknown>;
  manualCandidateById: (candidateId: string) => DesktopSetupState["manualCandidates"][number] | null;
  persistApprovedNodes: (nextNodes: ApprovedNodeRule[]) => ApprovedNodeRule[];
  runtimeDeviceById: (nodeId: string) => GatewayRuntimeDeviceSummary | null;
  resolveApprovedRuleIdForNode: (nodeId: string) => string | null;
  applyManualScanPayload: (payload: {
    state?: DesktopSetupState["manualScanState"];
    pairingCandidateId?: string | null;
    error?: string | null;
    candidates?: DesktopSetupState["manualCandidates"];
  }) => void;
  setWindowsScanRequested: (requested: boolean) => void;
};

export type OperatorIntents = {
  startManualScan: () => Promise<DesktopSetupState>;
  pairDiscoveredNode: (candidateId: string) => Promise<DesktopSetupState>;
  pairManualCandidate: (candidateId: string) => Promise<DesktopSetupState>;
  forgetNode: (nodeId: string) => Promise<DesktopSetupState>;
  recoverApprovedNode: (ruleId: string) => Promise<void>;
  resumeReconnectForNode: (nodeId: string) => Promise<void>;
  resumeApprovedNodeReconnect: (ruleId: string) => Promise<void>;
  setAllowedNodes: (nodes: ApprovedNodeRule[]) => Promise<DesktopSetupState>;
};

export function createOperatorIntents(
  deps: OperatorIntentDeps,
): OperatorIntents {
  async function startManualScan() {
    if (deps.getChild()) {
      await deps.sendGatewayCommand({ type: "start_manual_scan" });
      return deps.getSetupState();
    }

    deps.applyManualScanPayload({
      state: "scanning",
      pairingCandidateId: null,
      error: null,
      candidates: [],
    });
    deps.setWindowsScanRequested(true);
    await deps.restartRuntime();
    return deps.getSetupState();
  }

  async function pairDiscoveredNode(candidateId: string) {
    if (!candidateId) {
      return deps.getSetupState();
    }

    const candidate = deps.manualCandidateById(candidateId);
    if (!candidate) {
      throw new Error("That scan result is no longer available. Start a new manual scan.");
    }

    const nextApprovedNodes = deps.persistApprovedNodes([
      ...deps.getSetupState().approvedNodes,
      {
        id: candidate.id,
        label: candidate.label,
        peripheralId: candidate.peripheralId,
        address: candidate.address,
        localName: candidate.localName,
        knownDeviceId: candidate.knownDeviceId,
      },
    ]);

    deps.setSetupState({
      ...deps.getSetupState(),
      approvedNodes: nextApprovedNodes,
      manualScanState: "pairing",
      pairingCandidateId: candidateId,
      manualScanError: null,
    });
    deps.emitSetup();

    if (!deps.getChild()) {
      throw new Error("Windows BLE runtime is not running.");
    }

    await deps.sendGatewayCommand({
      type: "set_allowed_nodes",
      nodes: nextApprovedNodes,
    });
    await deps.sendGatewayCommand({
      type: "pair_manual_candidate",
      candidateId,
    });
    return deps.getSetupState();
  }

  async function resumeApprovedNodeReconnect(ruleId: string) {
    if (!ruleId) {
      return;
    }

    if (deps.getChild()) {
      await deps.sendGatewayCommand({ type: "resume_approved_node_reconnect", ruleId });
      return;
    }

    await deps.restartRuntime();
  }

  async function forgetNode(nodeId: string) {
    if (!nodeId) {
      return deps.getSetupState();
    }

    const setupState = deps.getSetupState();
    const directRule = setupState.approvedNodes.find((rule) => rule.id === nodeId);
    const runtimeDevice = deps.runtimeDeviceById(nodeId);
    const nextNodes = forgetApprovedNodeRules(
      setupState.approvedNodes,
      directRule ?? {
        id: nodeId,
        knownDeviceId: runtimeDevice?.id ?? nodeId,
        peripheralId: runtimeDevice?.peripheralId ?? null,
        address: runtimeDevice?.address ?? null,
        localName: runtimeDevice?.advertisedName ?? null,
      },
    );

    if (nextNodes.length === setupState.approvedNodes.length) {
      throw new Error("That device is no longer available to forget.");
    }

    const persistedNodes = deps.persistApprovedNodes(nextNodes);
    await deps.refreshAdapters();

    await deps.sendGatewayCommand({
      type: "set_allowed_nodes",
      nodes: persistedNodes,
    });
    deps.applyManualScanPayload({
      state: "idle",
      pairingCandidateId: null,
      error: null,
      candidates: [],
    });
    return deps.getSetupState();
  }

  async function recoverApprovedNode(ruleId: string) {
    if (!ruleId) {
      return;
    }

    if (deps.getChild()) {
      await deps.sendGatewayCommand({ type: "recover_approved_node", ruleId });
      return;
    }

    await deps.restartRuntime();
  }

  async function resumeReconnectForNode(nodeId: string) {
    const ruleId = deps.resolveApprovedRuleIdForNode(nodeId);
    if (!ruleId) {
      throw new Error("That device is no longer available to recover.");
    }

    await resumeApprovedNodeReconnect(ruleId);
  }

  async function setAllowedNodes(nodes: ApprovedNodeRule[]) {
    const nextNodes = deps.persistApprovedNodes(nodes);
    await deps.refreshAdapters();

    await deps.sendGatewayCommand({
      type: "set_allowed_nodes",
      nodes: nextNodes,
    });
    return deps.getSetupState();
  }

  return {
    startManualScan,
    pairDiscoveredNode,
    async pairManualCandidate(candidateId) {
      return pairDiscoveredNode(candidateId);
    },
    forgetNode,
    recoverApprovedNode,
    resumeReconnectForNode,
    resumeApprovedNodeReconnect,
    setAllowedNodes,
  };
}
