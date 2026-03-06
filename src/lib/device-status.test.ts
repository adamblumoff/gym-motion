import { describe, expect, it } from "bun:test";

import { deriveHealthStatus } from "@/lib/device-status";

describe("deriveHealthStatus", () => {
  it("marks recent contact as online", () => {
    expect(deriveHealthStatus(new Date().toISOString())).toBe("online");
  });

  it("marks moderately old contact as stale", () => {
    expect(deriveHealthStatus(new Date(Date.now() - 60_000).toISOString())).toBe(
      "stale",
    );
  });

  it("marks missing or old contact as offline", () => {
    expect(deriveHealthStatus(null)).toBe("offline");
    expect(
      deriveHealthStatus(new Date(Date.now() - 5 * 60_000).toISOString()),
    ).toBe("offline");
  });
});
