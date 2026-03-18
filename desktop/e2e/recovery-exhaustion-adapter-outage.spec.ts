import { expect, test } from "@playwright/test";

import { DEFAULT_APPROVED_RULE, launchDesktopApp } from "./test-utils";

test("recovery, reconnect exhaustion, telemetry drift, and adapter outages stay stable", async () => {
  const app = await launchDesktopApp({
    approvedNodes: [DEFAULT_APPROVED_RULE],
  });

  try {
    await app.step("connectApprovedNode");
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
          ?.gatewayConnectionState;
      })
      .toBe("connected");

    await app.step("disconnectLinkLost");
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Disconnected$/ }).first(),
    ).toBeVisible();

    await app.step("telemetryWhileDisconnected");
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
          ?.gatewayConnectionState;
      })
      .toBe("disconnected");
    await expect(app.page.getByText("Motion telemetry arrived while transport stayed disconnected.")).toBeVisible();

    await app.step("exhaustReconnect");
    await expect(app.page.getByText("Do you want to forget this device?")).toBeVisible();

    await app.page.getByRole("button", { name: /Keep Device/i }).click();
    await expect(app.page.getByText("Do you want to forget this device?")).toHaveCount(0);
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        const device = snapshot.devices.find(
          (current) => current.id === DEFAULT_APPROVED_RULE.knownDeviceId,
        );
        return {
          connectionState: device?.gatewayConnectionState ?? null,
          awaitingDecision: device?.reconnectAwaitingDecision ?? null,
          scanReason: snapshot.gateway.scanReason ?? null,
        };
      })
      .toEqual({
        connectionState: "disconnected",
        awaitingDecision: false,
        scanReason: "approved-reconnect",
      });

    await app.step("beginReconnectAttempt");
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Reconnecting$/ }).first(),
    ).toBeVisible();
    await app.step("completeReconnect");
    await expect(
      app.page.locator('[data-slot="badge"]').filter({ hasText: /^Connected$/ }).first(),
    ).toBeVisible();

    await app.step("adapterOff");
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        const device = snapshot.devices.find(
          (current) => current.id === DEFAULT_APPROVED_RULE.knownDeviceId,
        );
        return {
          adapterState: snapshot.gateway.adapterState,
          connectionState: device?.gatewayConnectionState ?? null,
          disconnectReason: device?.gatewayDisconnectReason ?? null,
        };
      })
      .toEqual({
        adapterState: "poweredOff",
        connectionState: "unreachable",
        disconnectReason: "adapter-poweredOff",
      });

    await app.step("adapterOn");
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return {
          adapterState: snapshot.gateway.adapterState,
          connectionState:
            snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
              ?.gatewayConnectionState ?? null,
          scanReason: snapshot.gateway.scanReason ?? null,
        };
      })
      .toEqual({
        adapterState: "poweredOn",
        connectionState: "disconnected",
        scanReason: "approved-reconnect",
      });

    await app.step("beginReconnectAttempt");
    await app.step("completeReconnect");
    await expect
      .poll(async () => {
        const snapshot = await app.getSnapshot();
        return snapshot.devices.find((device) => device.id === DEFAULT_APPROVED_RULE.knownDeviceId)
          ?.gatewayConnectionState;
      })
      .toBe("connected");
  } finally {
    await app.close();
  }
});
