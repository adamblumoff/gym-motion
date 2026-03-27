import { parseDevRunnerArgs, turboCommandArgs } from "./dev-runner";
import { runTaskMode } from "./dev-entry";

describe("dev runner cli", () => {
  it("parses dry-run arguments", () => {
    expect(parseDevRunnerArgs(["dev", "--dry-run"])).toEqual({
      mode: "dev",
      dryRun: true,
      turboArgs: [],
    });
  });

  it("passes through turbo arguments", () => {
    expect(parseDevRunnerArgs(["dev:desktop", "--continue", "--summarize"])).toEqual({
      mode: "dev:desktop",
      dryRun: false,
      turboArgs: ["--continue", "--summarize"],
    });
  });

  it("builds turbo invocations with tui mode", () => {
    expect(turboCommandArgs("dev:test-desktop", ["--continue"])).toEqual([
      "turbo",
      "run",
      "dev:test-desktop",
      "--ui=tui",
      "--continue",
    ]);
  });

  it("supports the runtime extension-point no-op task", async () => {
    await expect(runTaskMode("dev:runtime")).resolves.toBeUndefined();
  });
});
