import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";

import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DesktopSnapshot,
} from "@core/contracts";
import type { DesktopTestStepName } from "@core/services";

const ROOT_DIR = process.cwd();
const FAKE_GATEWAY_CHILD = path.join(
  ROOT_DIR,
  "out",
  "runtime",
  "desktop",
  "e2e",
  "fake-gateway-child.js",
);

export const DEFAULT_APPROVED_RULE: ApprovedNodeRule = {
  id: "rule-f4e9d4",
  label: "Leg Press Sensor",
  peripheralId: "D4:E9:F4:B2:5A:0A",
  address: "D4:E9:F4:B2:5A:0A",
  localName: "GymMotion-f4e9d4",
  knownDeviceId: "esp32-085ab2f4e9d4",
};

type LaunchDesktopAppOptions = {
  approvedNodes?: ApprovedNodeRule[];
};

export type DesktopE2EApp = {
  electronApp: ElectronApplication;
  page: Page;
  userDataDir: string;
  close: () => Promise<void>;
  getSnapshot: () => Promise<DesktopSnapshot>;
  getSetupState: () => Promise<DesktopSetupState>;
  step: (name: DesktopTestStepName, payload?: unknown) => Promise<unknown>;
};

async function writePreferences(userDataDir: string, approvedNodes: ApprovedNodeRule[]) {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "preferences.json"),
    JSON.stringify(
      {
        "gym-motion.desktop.approved-nodes": approvedNodes,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function launchDesktopApp(
  options: LaunchDesktopAppOptions = {},
): Promise<DesktopE2EApp> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gym-motion-e2e-"));
  await writePreferences(userDataDir, options.approvedNodes ?? []);

  const {
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    ELECTRON_NO_ATTACH_CONSOLE: _electronNoAttachConsole,
    ...launchEnv
  } = process.env;

  const electronApp = await electron.launch({
    args: [ROOT_DIR],
    env: {
      ...launchEnv,
      GYM_MOTION_E2E: "1",
      GYM_MOTION_GATEWAY_CHILD_SCRIPT: FAKE_GATEWAY_CHILD,
      GYM_MOTION_E2E_USER_DATA_DIR: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => {
    return (
      typeof window.gymMotionDesktop !== "undefined" &&
      typeof window.gymMotionDesktopTest !== "undefined"
    );
  });
  await expect(page.getByText("Motion Tracking Dashboard")).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.gymMotionDesktop.getSnapshot())).runtimeState)
    .toBe("running");

  return {
    electronApp,
    page,
    userDataDir,
    async close() {
      await electronApp.close();
      await fs.rm(userDataDir, { recursive: true, force: true });
    },
    async getSnapshot() {
      return page.evaluate(() => window.gymMotionDesktop.getSnapshot());
    },
    async getSetupState() {
      return page.evaluate(() => window.gymMotionDesktop.getSetupState());
    },
    async step(name, payload) {
      return page.evaluate(
        async ({ nextName, nextPayload }) =>
          window.gymMotionDesktopTest?.step(nextName, nextPayload),
        { nextName: name, nextPayload: payload },
      );
    },
  };
}
