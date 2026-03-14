import { nativeTheme } from "electron";

import {
  normalizeThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@core/contracts";

const THEME_STORAGE_KEY = "gym-motion.desktop.theme";

type ThemeStore = {
  getString: (key: string) => string | undefined;
  setString: (key: string, value: string) => void;
};

export type ThemeState = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
};

function readPreference(store: ThemeStore) {
  return normalizeThemePreference(store.getString(THEME_STORAGE_KEY));
}

function resolveCurrentTheme(preference: ThemePreference): ResolvedTheme {
  return resolveTheme(preference, nativeTheme.shouldUseDarkColors);
}

export function createThemeController(store: ThemeStore) {
  function applyPreference(preference: ThemePreference): ThemeState {
    nativeTheme.themeSource = preference;

    const resolvedTheme = resolveCurrentTheme(preference);

    return {
      preference,
      resolvedTheme,
    };
  }

  function getState(): ThemeState {
    const preference = readPreference(store);
    return applyPreference(preference);
  }

  return {
    getState,
    setPreference(preference: ThemePreference): ThemeState {
      store.setString(THEME_STORAGE_KEY, preference);
      return applyPreference(preference);
    },
    subscribe(listener: (state: ThemeState) => void) {
      const handleUpdate = () => {
        listener(getState());
      };

      nativeTheme.on("updated", handleUpdate);

      return () => {
        nativeTheme.off("updated", handleUpdate);
      };
    },
  };
}
