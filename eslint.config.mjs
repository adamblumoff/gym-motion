import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["release/**", "dist/**", "out/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "backend/**/*.ts",
      "desktop/**/*.ts",
      "desktop/**/*.tsx",
      "shared/**/*.ts",
      "scripts/**/*.ts",
      "*.config.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
