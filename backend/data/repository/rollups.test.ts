import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasMotionRollupTables,
  resetMotionRollupAvailabilityCacheForTests,
} from "./rollups";

describe("hasMotionRollupTables", () => {
  beforeEach(() => {
    resetMotionRollupAvailabilityCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T12:00:00.000Z"));
  });

  afterEach(() => {
    resetMotionRollupAvailabilityCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-probes after the negative cache ttl and re-enables rollups without restart", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ hourly_name: null, daily_name: null }],
        })
        .mockResolvedValueOnce({
          rows: [{ hourly_name: "motion_rollups_hourly", daily_name: "motion_rollups_daily" }],
        }),
    };

    await expect(hasMotionRollupTables(client)).resolves.toBe(false);
    await expect(hasMotionRollupTables(client)).resolves.toBe(false);
    expect(client.query).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);

    await expect(hasMotionRollupTables(client)).resolves.toBe(true);
    await expect(hasMotionRollupTables(client)).resolves.toBe(true);

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
