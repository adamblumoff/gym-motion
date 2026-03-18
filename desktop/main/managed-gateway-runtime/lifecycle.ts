import type { DesktopSnapshot } from "@core/contracts";

import { createEmptySnapshot, degradedEmptySnapshot, liveStatusFor } from "./snapshot";
import type { ManualScanPayload } from "./common";

type RuntimeState = "starting" | "running" | "degraded" | "restarting";

type RuntimeLifecycleDeps = {
  getSnapshot: () => DesktopSnapshot;
  setSnapshot: (snapshot: DesktopSnapshot) => void;
  setStopped: (stopped: boolean) => void;
  stopChild: () => void;
  apiServerStart: () => Promise<void>;
  runtimeStartIssue: () => string | null;
  startChild: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  applyManualScanPayload: (payload: ManualScanPayload) => void;
  emitSnapshot: () => void;
  setWindowsScanRequested: (requested: boolean) => void;
};

type StartRuntimeOptions = {
  preserveSnapshot?: boolean;
};

export type RuntimeLifecycle = {
  startRuntime: (options?: StartRuntimeOptions) => Promise<void>;
  restartRuntime: () => Promise<DesktopSnapshot>;
};

export function createRuntimeLifecycle(
  deps: RuntimeLifecycleDeps,
): RuntimeLifecycle {
  function setRuntimeState(
    runtimeState: RuntimeState,
    gatewayIssue: string | null,
  ) {
    const currentSnapshot = deps.getSnapshot();
    const nextSnapshot = {
      ...currentSnapshot,
      runtimeState,
      gatewayIssue,
      liveStatus: liveStatusFor({
        ...currentSnapshot,
        runtimeState,
        gatewayIssue,
      }),
    };
    deps.setSnapshot(nextSnapshot);
    deps.emitSnapshot();
  }

  async function startRuntime(options?: StartRuntimeOptions) {
    const preserveSnapshot = options?.preserveSnapshot ?? false;

    if (!preserveSnapshot) {
      deps.setSnapshot(createEmptySnapshot());
      deps.emitSnapshot();
      deps.applyManualScanPayload({
        state: "idle",
        pairingCandidateId: null,
        error: null,
        candidates: [],
      });
    } else {
      setRuntimeState("restarting", null);
    }

    const startIssue = deps.runtimeStartIssue();
    if (startIssue) {
      deps.setSnapshot(degradedEmptySnapshot(startIssue));
      deps.emitSnapshot();
      return;
    }

    try {
      await deps.apiServerStart();
      await deps.startChild();
      await deps.refreshHistory();
      deps.emitSnapshot();
      deps.setWindowsScanRequested(false);
    } catch (error) {
      deps.setWindowsScanRequested(false);
      deps.setSnapshot(
        degradedEmptySnapshot(
          error instanceof Error ? error.message : "Gateway runtime failed to start.",
        ),
      );
      deps.emitSnapshot();
      throw error;
    }
  }

  async function restartRuntime() {
    deps.setStopped(false);
    deps.stopChild();
    setRuntimeState("restarting", null);
    await startRuntime({ preserveSnapshot: true });
    return deps.getSnapshot();
  }

  return {
    startRuntime,
    restartRuntime,
  };
}
