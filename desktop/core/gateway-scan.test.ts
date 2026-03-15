import { describe, expect, it } from "bun:test";

import { isOperatorVisibleScan } from "./gateway-scan";

describe("gateway scan helpers", () => {
  it("treats legacy scanning without a reason as operator-visible", () => {
    expect(isOperatorVisibleScan("scanning", null)).toBe(true);
    expect(isOperatorVisibleScan("scanning", "manual")).toBe(true);
    expect(isOperatorVisibleScan("scanning", "approved-reconnect")).toBe(false);
    expect(isOperatorVisibleScan("stopped", null)).toBe(false);
  });
});
