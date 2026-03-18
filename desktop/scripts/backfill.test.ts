import { describe, expect, it } from "bun:test";

import { shouldApplyBackfillMotionState } from "../../backend/data/repository/backfill";

describe("backfill motion state updates", () => {
  it("does not let backfill overwrite a device that already has live contact", () => {
    expect(shouldApplyBackfillMotionState(true, true)).toBe(false);
  });

  it("allows backfill to seed motion state before any live contact exists", () => {
    expect(shouldApplyBackfillMotionState(false, true)).toBe(true);
  });

  it("never updates motion state from log-only backfill batches", () => {
    expect(shouldApplyBackfillMotionState(false, false)).toBe(false);
    expect(shouldApplyBackfillMotionState(true, false)).toBe(false);
  });
});
