import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./desktop/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  outputDir: "playwright-results/desktop",
});
