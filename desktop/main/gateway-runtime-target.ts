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
  if (!usesWindowsNativeGateway(options.platform)) {
    throw new Error(`Unsupported desktop BLE platform: ${options.platform}`);
  }

  if (options.isPackaged) {
    return path.join(
      options.resourcesPath,
      "app.asar.unpacked",
      "out",
      "runtime",
      "desktop",
      "scripts",
      "windows-winrt-gateway.js",
    );
  }

  return path.join(
    options.cwd,
    "out",
    "runtime",
    "desktop",
    "scripts",
    "windows-winrt-gateway.js",
  );
}

export function resolveWindowsSidecarLaunch(options: {
  isPackaged: boolean;
  cwd: string;
  resourcesPath: string;
  execPath: string;
}) {
  if (options.isPackaged) {
    return {
      command: path.join(options.resourcesPath, "bin", "gym-motion-ble-winrt.exe"),
      args: [],
    };
  }

  return {
    command: path.join(
      options.cwd,
      "native",
      "windows-dotnet-ble-sidecar",
      "bin",
      "Release",
      "net9.0-windows10.0.19041.0",
      "publish",
      "gym-motion-ble-winrt.exe",
    ),
    args: [],
  };
}
