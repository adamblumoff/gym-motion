import { afterEach, describe, expect, it } from "bun:test";

import type { DesktopSetupState } from "@core/contracts";

import { createDesktopAppActions } from "./actions";
import { applySetupState } from "./reducer";
import { createInitialDesktopAppState, type DesktopAppState } from "./state";

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

describe("createDesktopAppActions", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("does not let a stale manual scan response overwrite a newer setup event", async () => {
    let resolveManualScan: (() => void) | null = null;
    let state: DesktopAppState = {
      ...createInitialDesktopAppState(),
      setup: createSetupState(),
    };
    const setState = (updater: DesktopAppState | ((current: DesktopAppState) => DesktopAppState)) => {
      state = typeof updater === "function" ? updater(state) : updater;
    };

    globalThis.window = {
      gymMotionDesktop: {
        startManualScan: () =>
          new Promise<void>((resolve) => {
            resolveManualScan = resolve;
          }),
      },
    } as Window & typeof globalThis;

    const actions = createDesktopAppActions(setState);
    const startPromise = actions.startManualScan();

    state = applySetupState(
      state,
      createSetupState({
        manualScanState: "scanning",
      }),
    );

    resolveManualScan?.();
    await startPromise;

    expect(state.setup?.manualScanState).toBe("scanning");
  });
});
