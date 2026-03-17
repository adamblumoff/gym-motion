export function createManualScanManager() {
  let manualScanState = "idle";
  let pairingCandidateId = null;
  let manualScanError = null;
  const manualScanCandidatesById = new Map();

  function sortCandidates() {
    return Array.from(manualScanCandidatesById.values()).toSorted(
      (left, right) =>
        new Date(right.lastSeenAt ?? 0).getTime() -
        new Date(left.lastSeenAt ?? 0).getTime(),
    );
  }

  function getPayload() {
    return {
      state: manualScanState,
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
  }) {
    manualScanState = state;
    pairingCandidateId = nextPairingCandidateId;
    manualScanError = error;

    if (clearCandidates) {
      manualScanCandidatesById.clear();
    }
  }

  function upsertCandidate(candidate) {
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
