import type { ResolvedTheme, ThemePreference } from "@core/contracts";
import type { ThemeState } from "@core/services";

export function applyThemeState(themeState: ThemeState) {
  const root = document.documentElement;

  root.dataset.themePreference = themeState.preference;
  root.dataset.theme = themeState.resolvedTheme;
  root.style.colorScheme = themeState.resolvedTheme;
}

export function createFallbackThemeState(
  preference: ThemePreference = "dark",
  resolvedTheme: ResolvedTheme = "dark",
): ThemeState {
  return {
    preference,
    resolvedTheme,
  };
}
