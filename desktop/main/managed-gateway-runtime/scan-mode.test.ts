import { describe, expect, it } from "vitest";

import { windowsRescanMode } from "./scan-mode";

describe("windowsRescanMode", () => {
  it("uses the startup reconnect policy when approved nodes already exist", () => {
    expect(windowsRescanMode(1)).toBe("startup-policy");
  });

  it("keeps manual discovery when there are no approved nodes yet", () => {
    expect(windowsRescanMode(0)).toBe("manual");
  });
});
