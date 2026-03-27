import os from "node:os";
import path from "node:path";

import {
  BASE_RENDERER_PORT,
  BASE_RUNTIME_PORT,
  DevInstanceStateSchema,
  createDevRunnerEnv,
  detectWorktreeContext,
  isDevRunnerMode,
  resolveDevHome,
  resolveDevPorts,
  resolveOffset,
} from "./dev-env-config";

describe("dev env config", () => {
  it("recognizes supported dev modes", () => {
    expect(isDevRunnerMode("dev")).toBe(true);
    expect(isDevRunnerMode("dev:desktop")).toBe(true);
    expect(isDevRunnerMode("wat")).toBe(false);
  });

  it("resolves a default dev home", () => {
    expect(resolveDevHome({}, "win32", "C:\\Users\\tester")).toBe(
      path.join("C:\\Users\\tester", ".gym-motion-dev"),
    );
    expect(resolveDevHome({}, "linux", "/home/tester")).toBe("/home/tester/.gym-motion-dev");
  });

  it("resolves an explicit offset", () => {
    expect(resolveOffset({ GYM_MOTION_PORT_OFFSET: "7" })).toEqual({
      offset: 7,
      source: "GYM_MOTION_PORT_OFFSET=7",
    });
  });

  it("hashes string instance ids into a stable offset", () => {
    const first = resolveOffset({ GYM_MOTION_DEV_INSTANCE: "bench-a" });
    const second = resolveOffset({ GYM_MOTION_DEV_INSTANCE: "bench-a" });
    expect(first).toEqual(second);
    expect(first.offset).toBeGreaterThan(0);
  });

  it("honors explicit ports", async () => {
    const ports = await resolveDevPorts({
      GYM_MOTION_RENDERER_PORT: "6001",
      GYM_MOTION_RUNTIME_PORT: "7001",
    });

    expect(ports.rendererPort).toBe(6001);
    expect(ports.runtimePort).toBe(7001);
    expect(ports.rendererPortExplicit).toBe(true);
    expect(ports.runtimePortExplicit).toBe(true);
  });

  it("probes upward when the initial offset is unavailable", async () => {
    const occupied = new Set([BASE_RENDERER_PORT, BASE_RUNTIME_PORT]);
    const ports = await resolveDevPorts({}, async (port) => !occupied.has(port));

    expect(ports.offset).toBe(1);
    expect(ports.rendererPort).toBe(BASE_RENDERER_PORT + 1);
    expect(ports.runtimePort).toBe(BASE_RUNTIME_PORT + 1);
  });

  it("detects t3 worktree paths", () => {
    expect(
      detectWorktreeContext(path.join(os.homedir(), ".t3", "worktrees", "gym-motion", "feature-a")),
    ).toEqual({
      isWorktree: true,
      worktreeName: "feature-a",
    });

    expect(detectWorktreeContext("C:\\Users\\adamb\\Code\\gym-motion")).toEqual({
      isWorktree: false,
    });
  });

  it("creates mode-specific environment variables", () => {
    const env = createDevRunnerEnv({
      devHome: "C:\\Users\\adamb\\.gym-motion-dev",
      mode: "dev:test-desktop",
      ports: {
        rendererPort: 5733,
        runtimePort: 4010,
        offset: 0,
        source: "default ports",
        rendererPortExplicit: false,
        runtimePortExplicit: false,
      },
    });

    expect(env.GYM_MOTION_DEV_HOME).toBe("C:\\Users\\adamb\\.gym-motion-dev");
    expect(env.GYM_MOTION_DEV_URL).toBe("http://localhost:5733/");
    expect(env.PORT).toBe("5733");
    expect(env.ELECTRON_RENDERER_PORT).toBe("5733");
    expect(env.GYM_MOTION_RUNTIME_PORT).toBe("4010");
    expect(env.GYM_MOTION_E2E).toBe("1");
    expect(env.GYM_MOTION_AUTO_BOOTSTRAP_FROM_CWD).toBe("1");
  });

  it("validates dev state files with the schema", () => {
    const parsed = DevInstanceStateSchema.parse({
      cwd: "C:\\Users\\adamb\\Code\\gym-motion",
      mode: "dev",
      rendererPort: 5733,
      runtimePort: 4010,
      startedAt: new Date().toISOString(),
      instanceId: null,
      isWorktree: false,
    });

    expect(parsed.mode).toBe("dev");
  });
});
