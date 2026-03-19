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
    include: ["backend/**/*.db.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    coverage: {
      enabled: false,
    },
  },
});
