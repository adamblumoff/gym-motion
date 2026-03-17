import type { DesktopSetupState, DesktopSnapshot } from "@core/contracts";
import type { ThemeState } from "@core/services";

import { createFallbackThemeState } from "../../lib/theme";

export type DesktopAppState = {
  snapshot: DesktopSnapshot | null;
  setup: DesktopSetupState | null;
  theme: ThemeState;
};

export function createInitialDesktopAppState(): DesktopAppState {
  return {
    snapshot: null,
    setup: null,
    theme: createFallbackThemeState(),
  };
}

export function isDesktopRuntimeLoaded(state: Pick<DesktopAppState, "snapshot" | "setup">) {
  return state.snapshot !== null && state.setup !== null;
}
