import { expect, test } from "@playwright/test";

import { launchDesktopApp } from "./test-utils";

test("sidebar navigation switches screens without a full renderer reload", async () => {
  const app = await launchDesktopApp();

  try {
    await app.page.locator("aside").getByRole("link", { name: /Setup Sensors/i }).click();
    await expect(app.page.getByText("Sensor Setup")).toBeVisible();

    await app.page.evaluate(() => {
      (window as Window & { __sidebarNavSentinel?: string }).__sidebarNavSentinel = "still-alive";
    });

    await app.page.locator("aside").getByRole("link", { name: /^Dashboard$/i }).click();

    await expect(app.page.getByText("Live runtime state")).toBeVisible();
    await expect(
      app.page.evaluate(
        () => (window as Window & { __sidebarNavSentinel?: string }).__sidebarNavSentinel ?? null,
      ),
    ).resolves.toBe("still-alive");
  } finally {
    await app.close();
  }
});
