import { expect, test } from "@playwright/test";

import { DEFAULT_APPROVED_RULE, launchDesktopApp } from "./test-utils";

test("approved reconnect stays disconnected until connect begins and cleans up on success", async () => {
  const app = await launchDesktopApp({
    approvedNodes: [DEFAULT_APPROVED_RULE],
  });

  try {
    await expect(app.page.getByText(/GymMotion-f4e9d4|Leg Press/i)).toBeVisible();
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Disconnected$/ }).first(),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return {
          deviceState:
            snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
              ?.gatewayConnectionState ?? null,
          reconnectingCount: snapshot.gateway.reconnectingNodeCount,
          scanReason: snapshot.gateway.scanReason ?? null,
        };
      })
      .toEqual({
        deviceState: "disconnected",
        reconnectingCount: 0,
        scanReason: "approved-reconnect",
      });

    await app.page.getByRole("link", { name: /Setup Sensors/i }).click();
    await expect(app.page.getByText("Sensor Setup")).toBeVisible();
    await expect(app.page.getByText("link lost")).toBeVisible();

    await app.step("beginReconnectAttempt");
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return {
          deviceState:
            snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
              ?.gatewayConnectionState ?? null,
          reconnectingCount: snapshot.gateway.reconnectingNodeCount,
          scanReason: snapshot.gateway.scanReason ?? null,
        };
      })
      .toEqual({
        deviceState: "reconnecting",
        reconnectingCount: 1,
        scanReason: "approved-reconnect",
      });
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Reconnecting$/ }).first(),
    ).toBeVisible();
    await expect(app.page.getByText("link lost")).toHaveCount(0);

    await app.step("completeReconnect");
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return {
          deviceState:
            snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
              ?.gatewayConnectionState ?? null,
          reconnectingCount: snapshot.gateway.reconnectingNodeCount,
          scanReason: snapshot.gateway.scanReason ?? null,
        };
      })
      .toEqual({
        deviceState: "connected",
        reconnectingCount: 0,
        scanReason: null,
      });
    await expect(app.page.getByText("1 devices configured")).toBeVisible();
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Connected$/ }).first(),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
