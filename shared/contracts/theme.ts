import { themePreferenceSchema } from "./schemas";
import type { ResolvedTheme, ThemePreference } from "./types";

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
