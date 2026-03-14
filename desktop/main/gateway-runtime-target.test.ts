import path from "node:path";

import { describe, expect, it } from "bun:test";

import {
  resolveGatewayScriptPath,
  resolveWindowsSidecarPath,
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
    ).toBe(path.join("/repo", "desktop", "scripts", "windows-winrt-gateway.mjs"));
  });

  it("resolves the legacy BLE gateway script path on Linux", () => {
    expect(
      resolveGatewayScriptPath({
        platform: "linux",
        isPackaged: false,
        cwd: "/repo",
        resourcesPath: "/resources",
      }),
    ).toBe(path.join("/repo", "legacy", "scripts", "ble-gateway.mjs"));
  });

  it("resolves the packaged sidecar path", () => {
    expect(
      resolveWindowsSidecarPath({
        isPackaged: true,
        cwd: "/repo",
        resourcesPath: "/resources",
      }),
    ).toBe(path.join("/resources", "bin", "gym-motion-ble-winrt.exe"));
  });
});
