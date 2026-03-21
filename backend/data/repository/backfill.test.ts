import { describe, expect, it } from "vitest";

import {
  computeProvenBackfillAckSequence,
  computeProvenFirmwareHistoryAckSequence,
  durableBackfillRecordKey,
} from "./backfill";

describe("computeProvenBackfillAckSequence", () => {
  it("advances to the requested ack when the batch is fully contiguous", () => {
    expect(
      computeProvenBackfillAckSequence({
        previousAckSequence: 0,
        requestedAckSequence: 3,
        records: [
          {
            kind: "motion",
            sequence: 1,
            state: "moving",
            timestamp: 100,
          },
          {
            kind: "node-log",
            sequence: 2,
            level: "info",
            code: "node.connected",
            message: "Gateway connected.",
          },
          {
            kind: "motion",
            sequence: 3,
            state: "still",
            timestamp: 101,
          },
        ],
        durableMotionSequences: [1, 3],
        durableLogSequences: [2],
      }),
    ).toBe(3);
  });

  it("clamps at the first missing sequence on an existing boot", () => {
    expect(
      computeProvenBackfillAckSequence({
        previousAckSequence: 5,
        requestedAckSequence: 8,
        records: [
          {
            kind: "motion",
            sequence: 6,
            state: "moving",
            timestamp: 100,
          },
          {
            kind: "motion",
            sequence: 8,
            state: "still",
            timestamp: 101,
          },
        ],
        durableMotionSequences: [6, 8],
        durableLogSequences: [],
      }),
    ).toBe(6);
  });

  it("counts already durable duplicates toward contiguous coverage", () => {
    expect(
      computeProvenBackfillAckSequence({
        previousAckSequence: 5,
        requestedAckSequence: 7,
        records: [
          {
            kind: "motion",
            sequence: 6,
            state: "moving",
            timestamp: 100,
          },
          {
            kind: "motion",
            sequence: 6,
            state: "moving",
            timestamp: 100,
          },
          {
            kind: "motion",
            sequence: 7,
            state: "still",
            timestamp: 101,
          },
        ],
        durableMotionSequences: [6, 7],
        durableLogSequences: [],
      }),
    ).toBe(7);
  });

  it("never jumps over an initial gap on a new boot", () => {
    expect(
      computeProvenBackfillAckSequence({
        previousAckSequence: 0,
        requestedAckSequence: 4,
        records: [
          {
            kind: "motion",
            sequence: 2,
            state: "moving",
            timestamp: 100,
          },
          {
            kind: "node-log",
            sequence: 3,
            level: "info",
            code: "node.connected",
            message: "Gateway connected.",
          },
          {
            kind: "motion",
            sequence: 4,
            state: "still",
            timestamp: 101,
          },
        ],
        durableMotionSequences: [2, 4],
        durableLogSequences: [3],
      }),
    ).toBe(0);
  });
});

describe("computeProvenFirmwareHistoryAckSequence", () => {
  it("advances to the latest record sequence when every record in the page is durable", () => {
    expect(
      computeProvenFirmwareHistoryAckSequence({
        previousAckSequence: 0,
        records: [
          {
            kind: "node-log",
            sequence: 765,
            level: "info",
            code: "device.boot",
            message: "BLE node booted.",
            bootId: "boot-a",
          },
          {
            kind: "motion",
            sequence: 766,
            state: "still",
            timestamp: 1,
            bootId: "boot-a",
          },
          {
            kind: "node-log",
            sequence: 767,
            level: "info",
            code: "runtime.app_session.online",
            message: "Windows app session lease is active.",
            bootId: "boot-a",
          },
        ],
        durableRecordKeys: [
          durableBackfillRecordKey({
            kind: "node-log",
            bootId: "boot-a",
            sequence: 765,
          }),
          durableBackfillRecordKey({
            kind: "motion",
            bootId: "boot-a",
            sequence: 766,
          }),
          durableBackfillRecordKey({
            kind: "node-log",
            bootId: "boot-a",
            sequence: 767,
          }),
        ],
      }),
    ).toBe(767);
  });

  it("stops at the first non-durable record in page order", () => {
    expect(
      computeProvenFirmwareHistoryAckSequence({
        previousAckSequence: 766,
        records: [
          {
            kind: "node-log",
            sequence: 767,
            level: "info",
            code: "runtime.app_session.online",
            message: "Windows app session lease is active.",
            bootId: "boot-a",
          },
          {
            kind: "motion",
            sequence: 768,
            state: "moving",
            timestamp: 2,
            bootId: "boot-a",
          },
        ],
        durableRecordKeys: [
          durableBackfillRecordKey({
            kind: "node-log",
            bootId: "boot-a",
            sequence: 767,
          }),
        ],
      }),
    ).toBe(767);
  });
});
