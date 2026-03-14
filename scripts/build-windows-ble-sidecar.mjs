import { spawn } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") {
  process.exit(0);
}

const manifestPath = path.join(
  process.cwd(),
  "native",
  "windows-ble-sidecar",
  "Cargo.toml",
);

const child = spawn(
  "cargo",
  ["build", "--release", "--manifest-path", manifestPath],
  {
    stdio: "inherit",
    shell: true,
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(
    "[native] failed to build the Windows BLE sidecar. Install the Rust MSVC toolchain on Windows before running the desktop app.",
  );
  console.error(error);
  process.exit(1);
});
