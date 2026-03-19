import { describe, expect, it, vi } from "vitest";

import { createRuntimeLifecycle } from "./lifecycle";
import { createEmptySnapshot } from "./snapshot";

describe("createRuntimeLifecycle", () => {
  it("keeps startup alive when history refresh fails", async () => {
    let snapshot = createEmptySnapshot();
    const emitSnapshot = vi.fn();
    const setGatewayIssue = vi.fn((issue: string | null) => {
      snapshot = {
        ...snapshot,
        gatewayIssue: issue,
      };
    });
    const onHistoryRefreshError = vi.fn((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      setGatewayIssue(`History refresh unavailable: ${detail}`);
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
      refreshHistory: async () => {
        throw new Error("connect ETIMEDOUT");
      },
      setGatewayIssue,
      onHistoryRefreshError,
      applyManualScanPayload: vi.fn(),
      emitSnapshot,
      setWindowsScanRequested: vi.fn(),
    });

    await expect(lifecycle.startRuntime()).resolves.toBeUndefined();

    expect(onHistoryRefreshError).toHaveBeenCalledOnce();
    expect(setGatewayIssue).toHaveBeenCalledWith("History refresh unavailable: connect ETIMEDOUT");
    expect(snapshot.runtimeState).toBe("running");
  });
});
