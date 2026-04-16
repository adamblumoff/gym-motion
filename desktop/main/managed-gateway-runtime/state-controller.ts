import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  DesktopSetupState,
  DesktopSnapshot,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

import { applyAutoAdapterSelection, deriveAdapterIssue } from "./adapters";
import type { ManualScanPayload } from "./common";
import { createEmptySetupState, createEmptySnapshot, liveStatusFor } from "./snapshot";

type RuntimeCacheLike = {
  getSnapshot: () => DesktopSnapshot;
  replaceSnapshot: (snapshot: DesktopSnapshot) => void;
  updateGateway: (
    gateway: DesktopSnapshot["gateway"],
    runtimeState: DesktopSnapshot["runtimeState"],
    gatewayIssue: string | null,
    liveStatus: string,
  ) => void;
  upsertDevice: (device: GatewayRuntimeDeviceSummary) => void;
  applyApprovedNodeFilter: (approvedNodes: ApprovedNodeRule[]) => boolean;
};

type ManagedRuntimeStateControllerDeps = {
  emit: (event: DesktopRuntimeEvent) => void;
  readApprovedNodes: () => ApprovedNodeRule[];
  runtimeCache: RuntimeCacheLike;
};

export function createManagedRuntimeStateController({
  emit,
  readApprovedNodes,
  runtimeCache,
}: ManagedRuntimeStateControllerDeps) {
  let snapshot = createEmptySnapshot();
  let setupState = createEmptySetupState();
  let discoveredAdapters: BleAdapterSummary[] = [];
  let autoSelectedAdapterId: string | null = null;
  let windowsScanRequested = false;

  function getSnapshot() {
    snapshot = runtimeCache.getSnapshot();
    return snapshot;
  }

  function setSnapshot(nextSnapshot: DesktopSnapshot) {
    runtimeCache.replaceSnapshot(nextSnapshot);
    snapshot = runtimeCache.getSnapshot();
  }

  function emitSnapshot() {
    emit({ type: "snapshot", snapshot });
  }

  function emitRuntimeBatch(
    patch: Extract<DesktopRuntimeEvent, { type: "runtime-batch" }>["patch"],
  ) {
    emit({
      type: "runtime-batch",
      patch,
    });
  }

  function getSetupState() {
    return setupState;
  }

  function setSetupState(nextSetupState: DesktopSetupState) {
    setupState = nextSetupState;
  }

  function emitSetup() {
    emit({
      type: "setup-updated",
      setup: setupState,
    });
  }

  function updateGatewayStatus(
    gateway: GatewayStatusSummary,
    runtimeState: DesktopSnapshot["runtimeState"],
    gatewayIssue: string | null,
  ) {
    const liveStatus = liveStatusFor({
      ...snapshot,
      gateway,
      runtimeState,
      gatewayIssue,
    });
    runtimeCache.updateGateway(gateway, runtimeState, gatewayIssue, liveStatus);
    snapshot = runtimeCache.getSnapshot();
    emitRuntimeBatch({
      gateway: {
        gateway,
        liveStatus,
        runtimeState,
        gatewayIssue,
      },
    });
  }

  function setGatewayIssue(issue: string | null) {
    runtimeCache.updateGateway(
      snapshot.gateway,
      snapshot.runtimeState,
      issue,
      liveStatusFor({
        ...snapshot,
        gatewayIssue: issue,
      }),
    );
    snapshot = runtimeCache.getSnapshot();
  }

  function emitGatewayIssueSnapshot() {
    emitRuntimeBatch({
      gateway: {
        gateway: snapshot.gateway,
        liveStatus: snapshot.liveStatus,
        runtimeState: snapshot.runtimeState,
        gatewayIssue: snapshot.gatewayIssue,
      },
    });
  }

  function getDiscoveredAdapters() {
    return discoveredAdapters;
  }

  function getSelectedAdapter() {
    return discoveredAdapters.find((adapter) => adapter.id === autoSelectedAdapterId) ?? null;
  }

  function applyAdapterSnapshot(
    adapters: BleAdapterSummary[],
    runtimeError: string | null = null,
  ) {
    const selectedAdapterId = applyAutoAdapterSelection(adapters, true);
    const adapterIssue = deriveAdapterIssue({
      adapters,
      selectedAdapterId,
      usesWindowsNativeGateway: true,
      runtimeError: runtimeError ?? undefined,
    });

    discoveredAdapters = adapters;
    autoSelectedAdapterId = selectedAdapterId;

    setupState = {
      ...setupState,
      adapterIssue,
      approvedNodes: readApprovedNodes(),
    };

    emitSetup();
  }

  function applyManualScanPayload(
    payload: ManualScanPayload,
    approvedNodes = readApprovedNodes(),
  ) {
    setupState = {
      ...setupState,
      approvedNodes,
      manualScanState: payload.state ?? "idle",
      pairingCandidateId: payload.pairingCandidateId ?? null,
      manualScanError: payload.error ?? null,
      manualCandidates: Array.isArray(payload.candidates) ? payload.candidates : [],
    };
    emitSetup();
  }

  function pruneSnapshotToApprovedNodes(approvedNodes = readApprovedNodes()) {
    if (!runtimeCache.applyApprovedNodeFilter(approvedNodes)) {
      return false;
    }

    snapshot = runtimeCache.getSnapshot();
    setSnapshot({
      ...snapshot,
      liveStatus: liveStatusFor(snapshot),
    });
    return true;
  }

  function pruneSnapshot(nextSnapshot: DesktopSnapshot) {
    const approvedNodes = readApprovedNodes();
    runtimeCache.replaceSnapshot(nextSnapshot);
    snapshot = runtimeCache.getSnapshot();
    if (pruneSnapshotToApprovedNodes(approvedNodes)) {
      return getSnapshot();
    }
    return snapshot;
  }

  function applyRuntimeDevicePatch(runtimeDevice: GatewayRuntimeDeviceSummary) {
    runtimeCache.upsertDevice(runtimeDevice);
    snapshot = runtimeCache.getSnapshot();
    if (pruneSnapshotToApprovedNodes()) {
      snapshot = runtimeCache.getSnapshot();
    }
    emitRuntimeBatch({
      devices: [runtimeDevice],
    });
  }

  function getWindowsScanRequested() {
    return windowsScanRequested;
  }

  function setWindowsScanRequested(requested: boolean) {
    windowsScanRequested = requested;
  }

  return {
    getSnapshot,
    setSnapshot,
    emitSnapshot,
    emitRuntimeBatch,
    getSetupState,
    setSetupState,
    emitSetup,
    updateGatewayStatus,
    setGatewayIssue,
    emitGatewayIssueSnapshot,
    getDiscoveredAdapters,
    getSelectedAdapter,
    applyAdapterSnapshot,
    applyManualScanPayload,
    pruneSnapshotToApprovedNodes,
    pruneSnapshot,
    applyRuntimeDevicePatch,
    getWindowsScanRequested,
    setWindowsScanRequested,
  };
}
