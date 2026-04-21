import type {
  DesktopSetupState,
  DesktopSnapshot,
  DeviceAnalyticsSnapshot,
} from "@core/contracts";
import type { ThemeState } from "@core/services";

import { createFallbackThemeState } from "../../lib/theme";

export type DesktopAppState = {
  snapshot: DesktopSnapshot | null;
  setup: DesktopSetupState | null;
  analyticsByKey: Record<string, DeviceAnalyticsSnapshot>;
  staleAnalyticsKeys: Record<string, true>;
  theme: ThemeState;
};

export function createInitialDesktopAppState(): DesktopAppState {
  return {
    snapshot: null,
    setup: null,
    analyticsByKey: {},
    staleAnalyticsKeys: {},
    theme: createFallbackThemeState(),
  };
}

export function isDesktopRuntimeLoaded(state: Pick<DesktopAppState, "snapshot" | "setup">) {
  return state.snapshot !== null && state.setup !== null;
}
