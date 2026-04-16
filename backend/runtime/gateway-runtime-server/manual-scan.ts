import type { ManualScanCandidateSummary, ManualScanState } from "@core/contracts";

type ManualScanPayload = {
  state: ManualScanState;
  pairingCandidateId: string | null;
  error: string | null;
  candidates: ManualScanCandidateSummary[];
};

type SetManualScanStateInput = {
  state: ManualScanState;
  pairingCandidateId?: string | null;
  error?: string | null;
  clearCandidates?: boolean;
};

export function createManualScanManager() {
  let manualScanState = "idle";
  let pairingCandidateId = null;
  let manualScanError = null;
  const manualScanCandidatesById = new Map<string, ManualScanCandidateSummary>();

  function sortCandidates() {
    return Array.from(manualScanCandidatesById.values()).toSorted(
      (left, right) =>
        new Date(right.lastSeenAt ?? 0).getTime() -
        new Date(left.lastSeenAt ?? 0).getTime(),
    );
  }

  function getPayload(): ManualScanPayload {
    return {
      state: manualScanState as ManualScanState,
      pairingCandidateId,
      error: manualScanError,
      candidates: sortCandidates(),
    };
  }

  function setState({
    state,
    pairingCandidateId: nextPairingCandidateId = null,
    error = null,
    clearCandidates = false,
  }: SetManualScanStateInput) {
    manualScanState = state;
    pairingCandidateId = nextPairingCandidateId;
    manualScanError = error;

    if (clearCandidates) {
      manualScanCandidatesById.clear();
    }
  }

  function upsertCandidate(candidate: Partial<ManualScanCandidateSummary> & { id?: string | null }) {
    if (!candidate?.id) {
      return;
    }

    manualScanCandidatesById.set(candidate.id, {
      id: candidate.id,
      label: candidate.label ?? candidate.localName ?? candidate.peripheralId ?? candidate.id,
      peripheralId: candidate.peripheralId ?? null,
      address: candidate.address ?? null,
      localName: candidate.localName ?? null,
      knownDeviceId: candidate.knownDeviceId ?? null,
      machineLabel: candidate.machineLabel ?? null,
      siteId: candidate.siteId ?? null,
      lastRssi: candidate.lastRssi ?? null,
      lastSeenAt: candidate.lastSeenAt ?? null,
    });
  }

  return {
    getPayload,
    setState,
    upsertCandidate,
  };
}
