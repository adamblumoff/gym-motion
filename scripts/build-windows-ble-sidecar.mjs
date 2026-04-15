import { spawn } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") {
  process.exit(0);
}

const child = spawn(
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
    "[native] failed to build the .NET Windows BLE sidecar. Install the .NET SDK on Windows before running the desktop app.",
  );
  console.error(error);
  process.exit(1);
});
