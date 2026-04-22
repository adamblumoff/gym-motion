import { getDesktopShellPalette, type ResolvedTheme, type ThemePreference } from "@core/contracts";
import type { ThemeState } from "@core/services";

export function applyThemeState(themeState: ThemeState) {
  const root = document.documentElement;
  const desktopShellPalette = getDesktopShellPalette(themeState.resolvedTheme);

  root.dataset.themePreference = themeState.preference;
  root.dataset.theme = themeState.resolvedTheme;
  root.style.colorScheme = themeState.resolvedTheme;
  root.style.setProperty("--desktop-shell-bg", desktopShellPalette.shellBackground);
  root.style.setProperty("--desktop-shell-border", desktopShellPalette.shellBorder);
  root.classList.toggle("dark", themeState.resolvedTheme === "dark");
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
