import { describe, expect, it, vi } from "vitest";

import { createRuntimeLifecycle } from "./lifecycle";
import { createEmptySnapshot } from "./snapshot";

describe("createRuntimeLifecycle", () => {
  it("keeps startup alive when snapshot refresh fails", async () => {
    let snapshot = createEmptySnapshot();
    const emitSnapshot = vi.fn();
    const setGatewayIssue = vi.fn((issue: string | null) => {
      snapshot = {
        ...snapshot,
        gatewayIssue: issue,
      };
    });
    const onSnapshotRefreshError = vi.fn((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      setGatewayIssue(`Snapshot refresh unavailable: ${detail}`);
    });

    const lifecycle = createRuntimeLifecycle({
      getSnapshot: () => snapshot,
      setSnapshot: (nextSnapshot) => {
        snapshot = nextSnapshot;
      },
      setStopped: vi.fn(),
      stopChild: vi.fn(),
      apiServerStart: async () => {},
      runtimeStartIssue: () => null,
      startChild: async () => {
        snapshot = {
          ...snapshot,
          runtimeState: "running",
        };
      },
      refreshSnapshotData: async () => {
        throw new Error("connect ETIMEDOUT");
      },
      setGatewayIssue,
      onSnapshotRefreshError,
      applyManualScanPayload: vi.fn(),
      emitSnapshot,
      setWindowsScanRequested: vi.fn(),
    });

    await expect(lifecycle.startRuntime()).resolves.toBeUndefined();

    expect(onSnapshotRefreshError).toHaveBeenCalledOnce();
    expect(setGatewayIssue).toHaveBeenCalledWith("Snapshot refresh unavailable: connect ETIMEDOUT");
    expect(snapshot.runtimeState).toBe("running");
  });
});
