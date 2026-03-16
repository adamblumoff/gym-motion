import { describe, expect, it } from "bun:test";

import {
  shouldWriteDiscoveryLog,
  shouldWriteSidecarLog,
} from "./windows-winrt-gateway-logging.mjs";

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

  it("suppresses reconnect trace info logs unless verbose mode is enabled", () => {
    expect(
      shouldWriteSidecarLog("info", "Reconnect handshake step: discovering services", false),
    ).toBe(false);
    expect(
      shouldWriteSidecarLog(
        "info",
        "Reconnect handshake GATT setup attempt 1/3",
        false,
      ),
    ).toBe(false);
    expect(
      shouldWriteSidecarLog(
        "info",
        "Pausing BLE scan while reconnect handshake is in flight.",
        false,
      ),
    ).toBe(false);
  });

  it("keeps reconnect trace info logs in verbose mode", () => {
    expect(
      shouldWriteSidecarLog("info", "Reconnect handshake step: discovering services", true),
    ).toBe(true);
  });

  it("always keeps non-info sidecar logs", () => {
    expect(
      shouldWriteSidecarLog("warn", "Reconnect handshake failed before session health.", false),
    ).toBe(true);
  });
});
