import { expect, test } from "@playwright/test";

import { launchDesktopApp } from "./test-utils";

test("manual pair and live analytics updates stay in sync", async () => {
  const app = await launchDesktopApp();

  try {
    await app.page.getByRole("link", { name: /Setup Sensors/i }).click();
    await expect(app.page.getByText("Sensor Setup")).toBeVisible();

    await app.page.getByRole("button", { name: /Start Scan/i }).click();
    await expect(app.page.getByText("Searching for Bluetooth devices...")).toBeVisible();
    await expect
      .poll(async () => (await app.getSetupState()).manualCandidates.length)
      .toBe(1);
    await expect(app.page.getByRole("button", { name: /Pair/i })).toBeVisible();

    await app.page.getByRole("button", { name: /Pair/i }).click();
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return snapshot.devices.find((device) => device.id === "esp32-085ab2f4e9d4")
          ?.gatewayConnectionState;
      })
      .toBe("connected");

    await expect(app.page.getByText("1 devices configured")).toBeVisible();
    await expect(app.page.getByText("Connected")).toBeVisible();

    await app.page.getByRole("link", { name: /Back to Dashboard/i }).click();
    await expect(app.page.getByText("Motion Tracking Dashboard")).toBeVisible();
    await expect(app.page.getByText(/GymMotion-f4e9d4|Leg Press/i)).toBeVisible();
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Connected$/ }).first(),
    ).toBeVisible();

    await app.page.getByRole("link", { name: /Analytics/i }).click();
    await expect(app.page.getByText("Analytics")).toBeVisible();
    await expect(app.page.getByText("Live Activity")).toBeVisible();
    await expect(app.page.getByText("Pairing completed and device connected.")).toBeVisible();
    await expect(app.page.getByText("Canonical snapshot")).toBeVisible();
  } finally {
    await app.close();
  }
});
