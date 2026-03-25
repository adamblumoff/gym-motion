import path from "node:path";

import { defineConfig } from "vitest/config";

const rootDir = path.resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.join(rootDir, "shared"),
      "@core": path.join(rootDir, "shared"),
      "@main": path.join(rootDir, "desktop", "main"),
      "@ui": path.join(rootDir, "desktop", "ui", "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: [
      "shared/**/*.test.ts",
      "desktop/**/*.test.ts",
      "backend/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: [
      "desktop/e2e/**/*.spec.ts",
      "backend/**/*.db.test.ts",
      "node_modules/**",
      "dist/**",
      "out/**",
      "release/**",
    ],
    coverage: {
      enabled: false,
    },
  },
});
