import { describe, expect, it } from "bun:test";

import { shouldApplyBackfillMotionState } from "../../backend/data/repository/backfill";

describe("backfill motion state updates", () => {
  it("does not let older backfill overwrite newer device motion state", () => {
    expect(shouldApplyBackfillMotionState(100, 99, true)).toBe(false);
  });

  it("allows newer backfill motion state to update the device summary", () => {
    expect(shouldApplyBackfillMotionState(100, 100, true)).toBe(true);
    expect(shouldApplyBackfillMotionState(100, 101, true)).toBe(true);
  });

  it("never updates motion state from log-only backfill batches", () => {
    expect(shouldApplyBackfillMotionState(100, 150, false)).toBe(false);
  });
});
