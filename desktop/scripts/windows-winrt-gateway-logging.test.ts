import { describe, expect, it } from "bun:test";

import { shouldWriteDiscoveryLog } from "./windows-winrt-gateway-logging.mjs";

describe("windows winrt gateway logging", () => {
  it("suppresses discovery logs during silent approved reconnect scans", () => {
    expect(shouldWriteDiscoveryLog("approved-reconnect")).toBe(false);
  });

  it("keeps discovery logs during manual scans", () => {
    expect(shouldWriteDiscoveryLog("manual")).toBe(true);
  });

  it("keeps discovery logs when scan reason is unavailable", () => {
    expect(shouldWriteDiscoveryLog(null)).toBe(true);
  });
});
