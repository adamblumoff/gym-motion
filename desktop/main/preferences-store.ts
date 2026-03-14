import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { app } from "electron";

export type PreferencesStore = {
  getString: (key: string) => string | undefined;
  setString: (key: string, value: string) => void;
  getJson: <T>(key: string) => T | undefined;
  setJson: (key: string, value: unknown) => void;
};

function readState(filePath: string) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createPreferencesStore(): PreferencesStore {
  const filePath = path.join(app.getPath("userData"), "preferences.json");

  function writeState(nextState: Record<string, unknown>) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(nextState, null, 2));
  }

  return {
    getString(key) {
      const value = readState(filePath)[key];
      return typeof value === "string" ? value : undefined;
    },
    setString(key, value) {
      writeState({
        ...readState(filePath),
        [key]: value,
      });
    },
    getJson<T>(key: string) {
      return readState(filePath)[key] as T | undefined;
    },
    setJson(key, value) {
      writeState({
        ...readState(filePath),
        [key]: value,
      });
    },
  };
}
