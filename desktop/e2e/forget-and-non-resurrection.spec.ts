import { expect, test } from "@playwright/test";

import { DEFAULT_APPROVED_RULE, launchDesktopApp } from "./test-utils";

test("forgetting a node prevents resurrection until it is scanned and paired again", async () => {
  const app = await launchDesktopApp({
    approvedNodes: [DEFAULT_APPROVED_RULE],
  });

  try {
    await app.step("connectApprovedNode");

    await app.page.evaluate(() => {
      window.location.hash = "#/setup";
    });
    await expect(app.page.getByText("Sensor Setup")).toBeVisible();
    await expect(app.page.getByText("1 devices configured")).toBeVisible();

    await app.page.getByRole("button", { name: /^Remove$/i }).click();
    await app.page.getByRole("button", { name: /Forget Device/i }).click();
    await expect(app.page.getByText("0 devices configured")).toBeVisible();
    await expect(app.page.getByText("No sensors paired yet. Scan and pair devices to get started.")).toBeVisible();

    await app.page.evaluate(() => {
      window.location.hash = "#/";
    });
    await expect(app.page.getByText("No sensors configured. Go to Setup to add devices.")).toBeVisible();

    await app.step("lateDiscovery");
    await expect
      .poll(async () => (await app.getSnapshot()).devices.length)
      .toBe(0);
    await expect(app.page.getByText("No sensors configured. Go to Setup to add devices.")).toBeVisible();

    await app.page.getByRole("link", { name: /Analytics/i }).click();
    await expect(app.page.getByText("No approved nodes are available for analytics yet.")).toBeVisible();
    await app.page.getByRole("link", { name: /^Dashboard$/i }).click();
    await expect(app.page.getByText("Motion Tracking")).toBeVisible();
    await expect(app.page.getByText("No sensors configured. Go to Setup to add devices.")).toBeVisible();

    await app.page.evaluate(() => {
      window.location.hash = "#/setup";
    });
    await expect(app.page.getByText("Sensor Setup")).toBeVisible();
    await app.page.getByRole("button", { name: /Start Scan/i }).click();
    await expect
      .poll(async () => (await app.getSetupState()).manualCandidates.length)
      .toBe(1);
    await expect(app.page.getByRole("button", { name: /Pair/i })).toBeVisible();

    await app.page.getByRole("button", { name: /Pair/i }).click();
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
          ?.gatewayConnectionState;
      })
      .toBe("connected");
    await expect(app.page.getByText("1 devices configured")).toBeVisible();
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Connected$/ }).first(),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
