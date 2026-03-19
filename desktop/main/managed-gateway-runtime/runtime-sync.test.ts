import { describe, expect, it, vi } from "vitest";

import { createEmptySnapshot } from "./snapshot";
import { createRuntimeSync } from "./runtime-sync";

describe("createRuntimeSync", () => {
  it("loads global recent activity without per-device activity fanout", async () => {
    let snapshot = createEmptySnapshot();
    const listDeviceActivity = vi.fn();
    const listRecentActivity = vi.fn(async () => [
      {
        id: "motion-1",
        deviceId: "stack-001",
        sequence: 1,
        kind: "motion" as const,
        title: "MOVING",
        message: "Gateway recorded moving for stack-001.",
        state: "moving" as const,
        level: null,
        code: "motion.state",
        delta: 3,
        eventTimestamp: 123,
        receivedAt: "2026-03-18T12:00:00.000Z",
        bootId: "boot-1",
        firmwareVersion: "1.0.0",
        hardwareId: "hw-1",
        metadata: { delta: 3 },
      },
    ]);

    const runtimeSync = createRuntimeSync({
      getSnapshot: () => snapshot,
      setSnapshot: (nextSnapshot) => {
        snapshot = nextSnapshot;
      },
      listDevices: async () => [],
      listRecentEvents: async () => [],
      listDeviceLogs: async () => [],
      listDeviceActivity,
      listRecentActivity,
    });

    await runtimeSync.refreshHistory();

    expect(listRecentActivity).toHaveBeenCalledOnce();
    expect(listDeviceActivity).not.toHaveBeenCalled();
    expect(snapshot.activities).toHaveLength(1);
  });
});
