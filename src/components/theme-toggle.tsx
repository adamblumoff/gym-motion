"use client";

import { useEffect, useState } from "react";

import {
  applyThemePreference,
  persistThemePreference,
  readThemePreference,
  type ThemePreference,
} from "@/lib/theme";

import styles from "./theme-toggle.module.css";

const OPTIONS: Array<{ label: string; value: ThemePreference }> = [
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
];

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    if (typeof document === "undefined") {
      return "dark";
    }

    return readThemePreference();
  });

  useEffect(() => {
    const mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");

    applyThemePreference(preference, mediaQueryList);

    const handleChange = () => {
      if (readThemePreference() === "system") {
        applyThemePreference("system", mediaQueryList);
      }
    };

    mediaQueryList.addEventListener("change", handleChange);

    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }, [preference]);

  function handleChange(nextPreference: ThemePreference) {
    const mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");

    setPreference(nextPreference);
    persistThemePreference(nextPreference);
    applyThemePreference(nextPreference, mediaQueryList);
  }

  return (
    <div aria-label="Theme" className={styles.toggle} role="tablist">
      {OPTIONS.map((option) => (
        <button
          aria-selected={option.value === preference}
          className={styles.option}
          data-active={option.value === preference}
          key={option.value}
          onClick={() => handleChange(option.value)}
          role="tab"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
