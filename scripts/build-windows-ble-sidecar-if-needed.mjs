import { spawn } from "node:child_process";

const cloudApiBaseUrl = process.env.GYM_MOTION_CLOUD_API_BASE_URL?.trim();

if (cloudApiBaseUrl) {
  console.info(
    `[native] skipping Windows BLE sidecar build because cloud mode is enabled (${cloudApiBaseUrl})`,
  );
  process.exit(0);
}

const child = spawn("bun", ["run", "scripts/build-windows-ble-sidecar.mjs"], {
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("[native] failed to prepare the Windows BLE sidecar.");
  console.error(error);
  process.exit(1);
});
