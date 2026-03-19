import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  findLatestDeviceMotionEventBeforeReceivedAt,
  listDeviceMotionEventsByReceivedAt,
  recordHeartbeat,
  recordMotionEvent,
} from "./motion-events";
import { closeDatabase, hasDatabaseTestEnv, resetDatabaseSchema } from "../test-helpers";

const describeDb = hasDatabaseTestEnv() ? describe : describe.skip;

describeDb("motion event repository", () => {
  beforeEach(async () => {
    await resetDatabaseSchema();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("deduplicates repeated motion sequences and returns the stored canonical event", async () => {
    const first = await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 9,
      sequence: 4,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });
    const second = await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 9,
      sequence: 4,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    expect(first.event).toMatchObject({
      sequence: 4,
      eventTimestamp: 100,
    });
    expect(second.event).toMatchObject({
      sequence: 4,
      eventTimestamp: 100,
    });
    expect(second.event?.id).toBe(first.event?.id);
  });

  it("orders received-at queries by receipt time and preserves heartbeat upserts", async () => {
    await recordHeartbeat({
      deviceId: "stack-001",
      timestamp: 50,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    await recordMotionEvent({
      deviceId: "stack-001",
      state: "moving",
      timestamp: 100,
      delta: 3,
      sequence: 1,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    await recordMotionEvent({
      deviceId: "stack-001",
      state: "still",
      timestamp: 110,
      delta: 0,
      sequence: 2,
      bootId: "boot-1",
      firmwareVersion: "0.5.3",
      hardwareId: "hw-1",
    });

    const events = await listDeviceMotionEventsByReceivedAt({
      deviceId: "stack-001",
      startReceivedAt: "1970-01-01T00:00:00.000Z",
    });
    const latestBeforeSecond = await findLatestDeviceMotionEventBeforeReceivedAt({
      deviceId: "stack-001",
      beforeReceivedAt: events[1]!.receivedAt,
    });

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(latestBeforeSecond).toMatchObject({
      sequence: 1,
      eventTimestamp: 100,
    });
  });
});
