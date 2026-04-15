import { spawn } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") {
  process.exit(0);
}

const gatewayBackend =
  process.env.GYM_MOTION_WINDOWS_BLE_BACKEND === "bridge" ||
  process.env.GYM_MOTION_USB_BLE_BRIDGE_PORT ||
  process.env.GYM_MOTION_USB_BLE_BRIDGE_SIMULATOR === "1"
    ? "bridge"
    : "winrt";

if (gatewayBackend === "bridge") {
  const child = spawn(
    "dotnet",
    [
      "publish",
      path.join(
        process.cwd(),
        "native",
        "windows-serial-bridge-relay",
        "GymMotion.WindowsSerialBridgeRelay.csproj",
      ),
      "-c",
      "Release",
      "-p:UseAppHost=true",
    ],
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
      "[native] failed to build the Windows USB bridge relay. Install the .NET SDK on Windows before running the desktop app.",
    );
    console.error(error);
    process.exit(1);
  });
} else {
  const implementation = process.env.GYM_MOTION_WINDOWS_SIDECAR_IMPL === "rust" ? "rust" : "dotnet";

  const child =
    implementation === "rust"
      ? spawn(
          "cargo",
          [
            "build",
            "--release",
            "--manifest-path",
            path.join(process.cwd(), "native", "windows-ble-sidecar", "Cargo.toml"),
          ],
          {
            stdio: "inherit",
            shell: true,
          },
        )
      : spawn(
          "dotnet",
          [
            "publish",
            path.join(
              process.cwd(),
              "native",
              "windows-dotnet-ble-sidecar",
              "GymMotion.WindowsBleSidecar.csproj",
            ),
            "-c",
            "Release",
            "-p:UseAppHost=true",
          ],
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
      implementation === "rust"
        ? "[native] failed to build the Rust Windows BLE sidecar. Install the Rust MSVC toolchain on Windows before running the desktop app."
        : "[native] failed to build the .NET Windows BLE sidecar. Install the .NET SDK on Windows before running the desktop app.",
    );
    console.error(error);
    process.exit(1);
  });
}
