import path from "node:path";

export function usesWindowsNativeGateway(platform: NodeJS.Platform) {
  return platform === "win32";
}

export function resolveGatewayScriptPath(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  cwd: string;
  resourcesPath: string;
}) {
  if (usesWindowsNativeGateway(options.platform)) {
    if (options.isPackaged) {
      return path.join(
        options.resourcesPath,
        "app.asar.unpacked",
        "desktop",
        "scripts",
        "windows-winrt-gateway.mjs",
      );
    }

    return path.join(options.cwd, "desktop", "scripts", "windows-winrt-gateway.mjs");
  }

  if (options.isPackaged) {
    return path.join(
      options.resourcesPath,
      "app.asar.unpacked",
      "legacy",
      "scripts",
      "ble-gateway.mjs",
    );
  }

  return path.join(options.cwd, "legacy", "scripts", "ble-gateway.mjs");
}

export function resolveWindowsSidecarPath(options: {
  isPackaged: boolean;
  cwd: string;
  resourcesPath: string;
}) {
  if (options.isPackaged) {
    return path.join(options.resourcesPath, "bin", "gym-motion-ble-winrt.exe");
  }

  return path.join(
    options.cwd,
    "native",
    "windows-ble-sidecar",
    "target",
    "release",
    "gym-motion-ble-winrt.exe",
  );
}
