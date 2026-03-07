export const THEME_STORAGE_KEY = "gym-motion.theme";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const VALID_THEME_PREFERENCES = new Set<ThemePreference>([
  "dark",
  "light",
  "system",
]);

export function normalizeThemePreference(
  value: string | null | undefined,
): ThemePreference {
  if (value && VALID_THEME_PREFERENCES.has(value as ThemePreference)) {
    return value as ThemePreference;
  }

  return "dark";
}

export function resolveTheme(
  preference: ThemePreference,
  mediaQueryList?: MediaQueryList,
): ResolvedTheme {
  if (preference !== "system") {
    return preference;
  }

  if (typeof window === "undefined" && !mediaQueryList) {
    return "dark";
  }

  const matcher =
    mediaQueryList ??
    window.matchMedia?.("(prefers-color-scheme: dark)");

  return matcher?.matches ? "dark" : "light";
}

export function applyThemePreference(
  preference: ThemePreference,
  mediaQueryList?: MediaQueryList,
) {
  if (typeof document === "undefined") {
    return;
  }

  const resolvedTheme = resolveTheme(preference, mediaQueryList);
  const root = document.documentElement;

  root.dataset.themePreference = preference;
  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
}

export function readThemePreference(): ThemePreference {
  if (typeof document !== "undefined") {
    const rawPreference = document.documentElement.dataset.themePreference;

    if (rawPreference) {
      return normalizeThemePreference(rawPreference);
    }
  }

  if (typeof window !== "undefined") {
    return normalizeThemePreference(
      window.localStorage.getItem(THEME_STORAGE_KEY),
    );
  }

  return "dark";
}

export function persistThemePreference(preference: ThemePreference) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
}

export const themeBootstrapScript = `(() => {
  const storageKey = ${JSON.stringify(THEME_STORAGE_KEY)};
  const valid = new Set(["dark", "light", "system"]);
  const stored = window.localStorage.getItem(storageKey);
  const preference = valid.has(stored) ? stored : "dark";
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;

  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();`;
