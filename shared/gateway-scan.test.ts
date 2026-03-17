import { describe, expect, it } from "bun:test";

import { isOperatorVisibleScan, liveStatusLabelForScan } from "@core/gateway-scan";

describe("gateway scan helpers", () => {
  it("treats legacy scanning without a reason as operator-visible", () => {
    expect(isOperatorVisibleScan("scanning", null)).toBe(true);
    expect(isOperatorVisibleScan("scanning", "manual")).toBe(true);
    expect(isOperatorVisibleScan("scanning", "approved-reconnect")).toBe(false);
    expect(isOperatorVisibleScan("stopped", null)).toBe(false);
  });

  it("prefers reconnecting status over generic legacy scanning", () => {
    expect(liveStatusLabelForScan("scanning", null, 1)).toBe(
      "Reconnecting approved nodes",
    );
    expect(liveStatusLabelForScan("scanning", "manual", 0)).toBe(
      "Scanning for BLE nodes",
    );
    expect(liveStatusLabelForScan("scanning", "approved-reconnect", 0)).toBeNull();
    expect(liveStatusLabelForScan("stopped", null, 1)).toBeNull();
  });
});
