import { themePreferenceSchema } from "./schemas";
import type { ResolvedTheme, ThemePreference } from "./types";

export type DesktopShellPalette = {
  shellBackground: string;
  shellBorder: string;
  windowBackground: string;
  titleBarSymbol: string;
};

const DESKTOP_SHELL_PALETTES: Record<ResolvedTheme, DesktopShellPalette> = {
  dark: {
    shellBackground: "#000000",
    shellBorder: "rgba(255, 255, 255, 0.08)",
    windowBackground: "#000000",
    titleBarSymbol: "#f4f4f0",
  },
  light: {
    shellBackground: "#ffffff",
    shellBorder: "rgba(16, 17, 19, 0.08)",
    windowBackground: "#f4f4f0",
    titleBarSymbol: "#101113",
  },
};

export function normalizeThemePreference(
  value: string | null | undefined,
): ThemePreference {
  const result = themePreferenceSchema.safeParse(value);
  return result.success ? result.data : "dark";
}

export function resolveTheme(
  preference: ThemePreference,
  systemWantsDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemWantsDark ? "dark" : "light";
  }

  return preference;
}

export function getDesktopShellPalette(resolvedTheme: ResolvedTheme): DesktopShellPalette {
  return DESKTOP_SHELL_PALETTES[resolvedTheme];
}
