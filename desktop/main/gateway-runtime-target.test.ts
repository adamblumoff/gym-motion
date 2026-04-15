import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveGatewayScriptPath,
  resolveWindowsSidecarLaunch,
  usesWindowsNativeGateway,
} from "./gateway-runtime-target";

describe("gateway runtime target", () => {
  it("switches to the native gateway on Windows", () => {
    expect(usesWindowsNativeGateway("win32")).toBe(true);
    expect(usesWindowsNativeGateway("linux")).toBe(false);
  });

  it("resolves the Windows gateway script path in dev", () => {
    expect(
      resolveGatewayScriptPath({
        platform: "win32",
        isPackaged: false,
        cwd: "/repo",
        resourcesPath: "/resources",
      }),
    ).toBe(
      path.join("/repo", "out", "runtime", "desktop", "scripts", "windows-winrt-gateway.js"),
    );
  });

  it("rejects non-Windows runtime paths", () => {
    expect(() =>
      resolveGatewayScriptPath({
        platform: "linux",
        isPackaged: false,
        cwd: "/repo",
        resourcesPath: "/resources",
      }),
    ).toThrow("Unsupported desktop BLE platform: linux");
  });

  it("resolves the packaged sidecar path", () => {
    expect(
      resolveWindowsSidecarLaunch({
        isPackaged: true,
        cwd: "/repo",
        resourcesPath: "/resources",
        execPath: "/electron",
      }),
    ).toEqual({
      command: path.join("/resources", "bin", "gym-motion-ble-winrt.exe"),
      args: [],
    });
  });

  it("resolves the .NET sidecar path in dev by default", () => {
    delete process.env.GYM_MOTION_WINDOWS_SIDECAR_IMPL;
    delete process.env.GYM_MOTION_WINDOWS_BLE_BACKEND;
    delete process.env.GYM_MOTION_USB_BLE_BRIDGE_PORT;
    delete process.env.GYM_MOTION_USB_BLE_BRIDGE_SIMULATOR;

    expect(
      resolveWindowsSidecarLaunch({
        isPackaged: false,
        cwd: "/repo",
        resourcesPath: "/resources",
        execPath: "/electron",
      }),
    ).toEqual({
      command: path.join(
        "/repo",
        "native",
        "windows-dotnet-ble-sidecar",
        "bin",
        "Release",
        "net9.0-windows10.0.19041.0",
        "publish",
        "gym-motion-ble-winrt.exe",
      ),
      args: [],
    });
  });

  it("prefers the bridge sidecar when bridge mode is configured", () => {
    process.env.GYM_MOTION_WINDOWS_BLE_BACKEND = "bridge";

    expect(
      resolveWindowsSidecarLaunch({
        isPackaged: false,
        cwd: "/repo",
        resourcesPath: "/resources",
        execPath: "/electron",
      }),
    ).toEqual({
      command: "/electron",
      args: [
        path.join(
          "/repo",
          "out",
          "runtime",
          "desktop",
          "scripts",
          "windows-serial-bridge-sidecar.js",
        ),
      ],
    });

    delete process.env.GYM_MOTION_WINDOWS_BLE_BACKEND;
  });
});
