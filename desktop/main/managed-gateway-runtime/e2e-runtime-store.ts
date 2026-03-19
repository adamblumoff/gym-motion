import type {
  AnalyticsWindow,
  BackfillBatchInput,
  BackfillBatchResult,
  DeviceActivitySummary,
  DeviceLogInput,
  DeviceLogSummary,
  DeviceSummary,
  DeviceSyncStateSummary,
  HeartbeatPayload,
  IngestPayload,
  MotionEventSummary,
  MotionStreamPayload,
} from "@core/contracts";

function isoNow() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultDevice(deviceId: string): DeviceSummary {
  return {
    id: deviceId,
    lastState: "still",
    lastSeenAt: 0,
    lastDelta: null,
    updatedAt: isoNow(),
    hardwareId: null,
    bootId: null,
    firmwareVersion: "test",
    machineLabel: null,
    siteId: null,
    provisioningState: "provisioned",
    updateStatus: "idle",
    updateTargetVersion: null,
    updateDetail: null,
    updateUpdatedAt: null,
    lastHeartbeatAt: null,
    lastEventReceivedAt: null,
    healthStatus: "offline",
  };
}

function motionToActivity(event: MotionEventSummary): DeviceActivitySummary {
  return {
    id: `motion-${event.id}`,
    deviceId: event.deviceId,
    sequence: event.sequence,
    kind: "motion",
    title: event.state.toUpperCase(),
    message: `Gateway recorded ${event.state} for ${event.deviceId}.`,
    state: event.state,
    level: null,
    code: "motion.state",
    delta: event.delta,
    eventTimestamp: event.eventTimestamp,
    receivedAt: event.receivedAt,
    bootId: event.bootId,
    firmwareVersion: event.firmwareVersion,
    hardwareId: event.hardwareId,
    metadata: event.delta === null ? null : { delta: event.delta },
  };
}

function logToActivity(log: DeviceLogSummary): DeviceActivitySummary {
  return {
    id: `log-${log.id}`,
    deviceId: log.deviceId,
    sequence: log.sequence,
    kind: "lifecycle",
    title: log.code ?? log.level.toUpperCase(),
    message: log.message,
    state: null,
    level: log.level,
    code: log.code,
    delta: null,
    eventTimestamp: log.deviceTimestamp,
    receivedAt: log.receivedAt,
    bootId: log.bootId,
    firmwareVersion: log.firmwareVersion,
    hardwareId: log.hardwareId,
    metadata: log.metadata,
  };
}

function sortActivities(activities: DeviceActivitySummary[], limit: number) {
  return [...activities]
    .sort(
      (left, right) =>
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt) ||
        right.id.localeCompare(left.id),
    )
    .slice(0, limit);
}

function floorBucketStart(timestamp: number, bucketMs: number) {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

export function createE2eRuntimeStore() {
  const devices = new Map<string, DeviceSummary>();
  const motionEvents = new Map<string, MotionEventSummary[]>();
  const deviceLogs = new Map<string, DeviceLogSummary[]>();
  const syncStates = new Map<string, DeviceSyncStateSummary>();
  let nextMotionEventId = 1;
  let nextDeviceLogId = 1;

  function getDevice(deviceId: string) {
    return clone(devices.get(deviceId) ?? defaultDevice(deviceId));
  }

  function setDevice(device: DeviceSummary) {
    devices.set(device.id, clone(device));
    return clone(device);
  }

  function addMotionEvent(event: MotionEventSummary) {
    const current = motionEvents.get(event.deviceId) ?? [];
    motionEvents.set(
      event.deviceId,
      [...current, clone(event)].sort(
        (left, right) =>
          Date.parse(left.receivedAt) - Date.parse(right.receivedAt) ||
          left.eventTimestamp - right.eventTimestamp ||
          left.id - right.id,
      ),
    );
  }

  function addDeviceLog(log: DeviceLogSummary) {
    const current = deviceLogs.get(log.deviceId) ?? [];
    deviceLogs.set(
      log.deviceId,
      [clone(log), ...current].sort(
        (left, right) =>
          Date.parse(right.receivedAt) - Date.parse(left.receivedAt) ||
          right.id - left.id,
      ),
    );
  }

  function updateDeviceFromMotion(payload: IngestPayload) {
    const now = isoNow();
    const nextDevice = {
      ...getDevice(payload.deviceId),
      lastState: payload.state,
      lastSeenAt: payload.timestamp,
      lastDelta: payload.delta ?? null,
      updatedAt: now,
      hardwareId: payload.hardwareId ?? null,
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? "test",
      lastEventReceivedAt: now,
      healthStatus: "online" as const,
    };

    return setDevice(nextDevice);
  }

  function updateDeviceFromHeartbeat(payload: HeartbeatPayload) {
    const now = isoNow();
    const nextDevice = {
      ...getDevice(payload.deviceId),
      lastSeenAt: payload.timestamp,
      updatedAt: now,
      hardwareId: payload.hardwareId ?? null,
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? "test",
      lastHeartbeatAt: now,
      healthStatus: "online" as const,
    };

    return setDevice(nextDevice);
  }

  async function recordMotion(payload: IngestPayload): Promise<MotionStreamPayload> {
    const device = updateDeviceFromMotion(payload);
    const event: MotionEventSummary = {
      id: nextMotionEventId,
      deviceId: payload.deviceId,
      sequence: payload.sequence ?? null,
      state: payload.state,
      delta: payload.delta ?? null,
      eventTimestamp: payload.timestamp,
      receivedAt: isoNow(),
      bootId: payload.bootId ?? null,
      firmwareVersion: payload.firmwareVersion ?? "test",
      hardwareId: payload.hardwareId ?? null,
    };
    nextMotionEventId += 1;
    addMotionEvent(event);
    return {
      device,
      event,
    };
  }

  async function recordHeartbeat(payload: HeartbeatPayload): Promise<MotionStreamPayload> {
    return {
      device: updateDeviceFromHeartbeat(payload),
    };
  }

  async function recordLog(input: DeviceLogInput): Promise<DeviceLogSummary> {
    const log: DeviceLogSummary = {
      id: nextDeviceLogId,
      deviceId: input.deviceId,
      sequence: input.sequence ?? null,
      level: input.level,
      code: input.code,
      message: input.message,
      bootId: input.bootId ?? null,
      firmwareVersion: input.firmwareVersion ?? null,
      hardwareId: input.hardwareId ?? null,
      deviceTimestamp: input.timestamp ?? null,
      metadata: input.metadata ?? null,
      receivedAt: isoNow(),
    };
    nextDeviceLogId += 1;
    addDeviceLog(log);
    return clone(log);
  }

  async function recordBackfill(input: BackfillBatchInput): Promise<BackfillBatchResult> {
    const insertedEvents: MotionEventSummary[] = [];
    const insertedLogs: DeviceLogSummary[] = [];

    for (const record of input.records) {
      if (record.kind === "motion") {
        const payload = await recordMotion({
          deviceId: input.deviceId,
          state: record.state,
          timestamp: record.timestamp,
          delta: record.delta ?? null,
          sequence: record.sequence,
          bootId: record.bootId ?? input.bootId ?? undefined,
          firmwareVersion: record.firmwareVersion ?? undefined,
          hardwareId: record.hardwareId ?? undefined,
        });
        if (payload.event) {
          insertedEvents.push(payload.event);
        }
        continue;
      }

      insertedLogs.push(
        await recordLog({
          deviceId: input.deviceId,
          level: record.level,
          code: record.code,
          message: record.message,
          sequence: record.sequence,
          bootId: record.bootId ?? input.bootId ?? undefined,
          firmwareVersion: record.firmwareVersion ?? undefined,
          hardwareId: record.hardwareId ?? undefined,
          timestamp: record.timestamp ?? undefined,
          metadata: record.metadata ?? undefined,
        }),
      );
    }

    const syncState: DeviceSyncStateSummary = {
      deviceId: input.deviceId,
      lastAckedSequence: input.ackSequence,
      lastAckedBootId: input.bootId ?? null,
      lastSyncCompletedAt: isoNow(),
      lastOverflowDetectedAt: input.overflowDetectedAt ?? null,
    };
    syncStates.set(input.deviceId, clone(syncState));

    return {
      insertedEvents,
      insertedLogs,
      syncState,
    };
  }

  return {
    recordMotion,
    recordHeartbeat,
    recordLog,
    recordBackfill,

    async listDevices() {
      return [...devices.values()]
        .map(clone)
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
            left.id.localeCompare(right.id),
        );
    },

    async listRecentEvents(limit = 12) {
      return [...motionEvents.values()]
        .flat()
        .map(clone)
        .sort(
          (left, right) =>
            Date.parse(right.receivedAt) - Date.parse(left.receivedAt) ||
            right.id - left.id,
        )
        .slice(0, limit);
    },

    async listDeviceLogs(options?: { deviceId?: string | null; limit?: number }) {
      const limit = Math.min(Math.max(options?.limit ?? 100, 1), 250);
      const logs = options?.deviceId
        ? deviceLogs.get(options.deviceId) ?? []
        : [...deviceLogs.values()].flat();

      return logs
        .map(clone)
        .sort(
          (left, right) =>
            Date.parse(right.receivedAt) - Date.parse(left.receivedAt) ||
            right.id - left.id,
        )
        .slice(0, limit);
    },

    async listDeviceActivity(options: { deviceId: string; limit?: number }) {
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 250);
      return sortActivities(
        [
          ...(motionEvents.get(options.deviceId) ?? []).map(motionToActivity),
          ...(deviceLogs.get(options.deviceId) ?? []).map(logToActivity),
        ],
        limit,
      );
    },

    async listRecentActivity(limit = 30) {
      return sortActivities(
        [
          ...[...motionEvents.values()].flat().map(motionToActivity),
          ...[...deviceLogs.values()].flat().map(logToActivity),
        ],
        Math.min(Math.max(limit, 1), 250),
      );
    },

    async listMotionRollupBuckets(args: {
      deviceId: string;
      window: AnalyticsWindow;
      startBucket: number;
      endBucketExclusive: number;
    }) {
      const bucketMs = args.window === "24h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const bucketMap = new Map<number, { movementCount: number; movingSeconds: number }>();
      const events = [...(motionEvents.get(args.deviceId) ?? [])].sort(
        (left, right) => left.eventTimestamp - right.eventTimestamp || left.id - right.id,
      );
      let previousState: MotionEventSummary["state"] = "still";
      let previousTimestamp = args.startBucket;

      for (const event of events) {
        if (event.eventTimestamp < args.startBucket) {
          previousState = event.state;
          previousTimestamp = event.eventTimestamp;
          continue;
        }

        if (previousState === "moving" && event.eventTimestamp > previousTimestamp) {
          let cursor = Math.max(previousTimestamp, args.startBucket);
          const end = Math.min(event.eventTimestamp, args.endBucketExclusive);

          while (cursor < end) {
            const bucketStart = floorBucketStart(cursor, bucketMs);
            const bucket = bucketMap.get(bucketStart) ?? {
              movementCount: 0,
              movingSeconds: 0,
            };
            const segmentEnd = Math.min(bucketStart + bucketMs, end);
            bucket.movingSeconds += Math.round((segmentEnd - cursor) / 1000);
            bucketMap.set(bucketStart, bucket);
            cursor = segmentEnd;
          }
        }

        if (
          event.state === "moving" &&
          previousState !== "moving" &&
          event.eventTimestamp >= args.startBucket &&
          event.eventTimestamp < args.endBucketExclusive
        ) {
          const bucketStart = floorBucketStart(event.eventTimestamp, bucketMs);
          const bucket = bucketMap.get(bucketStart) ?? {
            movementCount: 0,
            movingSeconds: 0,
          };
          bucket.movementCount += 1;
          bucketMap.set(bucketStart, bucket);
        }

        previousState = event.state;
        previousTimestamp = event.eventTimestamp;
      }

      return [...bucketMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([bucketStart, summary]) => ({
          deviceId: args.deviceId,
          bucketStart,
          movementCount: summary.movementCount,
          movingSeconds: summary.movingSeconds,
          updatedAt: isoNow(),
        }));
    },

    async listDeviceMotionEvents(args: {
      deviceId: string;
      startTimestamp: number;
      endTimestamp?: number;
    }) {
      const end = args.endTimestamp ?? Date.now();
      return (motionEvents.get(args.deviceId) ?? [])
        .filter(
          (event) =>
            event.eventTimestamp >= args.startTimestamp && event.eventTimestamp < end,
        )
        .map(clone)
        .sort((left, right) => left.eventTimestamp - right.eventTimestamp || left.id - right.id);
    },

    async findLatestDeviceMotionEventBefore(args: {
      deviceId: string;
      beforeTimestamp: number;
    }) {
      const matches = (motionEvents.get(args.deviceId) ?? []).filter(
        (event) => event.eventTimestamp < args.beforeTimestamp,
      );
      return matches.length > 0
        ? clone(
            [...matches].sort(
              (left, right) => right.eventTimestamp - left.eventTimestamp || right.id - left.id,
            )[0] ?? null,
          )
        : null;
    },

    async listDeviceMotionEventsByReceivedAt(args: {
      deviceId: string;
      startReceivedAt: string;
      endReceivedAt?: string;
    }) {
      const start = Date.parse(args.startReceivedAt);
      const end = Date.parse(args.endReceivedAt ?? isoNow());
      return (motionEvents.get(args.deviceId) ?? [])
        .filter((event) => {
          const receivedAt = Date.parse(event.receivedAt);
          return receivedAt >= start && receivedAt < end;
        })
        .map(clone);
    },

    async findLatestDeviceMotionEventBeforeReceivedAt(args: {
      deviceId: string;
      beforeReceivedAt: string;
    }) {
      const cutoff = Date.parse(args.beforeReceivedAt);
      const matches = (motionEvents.get(args.deviceId) ?? []).filter(
        (event) => Date.parse(event.receivedAt) < cutoff,
      );
      return matches.length > 0 ? clone(matches.at(-1) ?? null) : null;
    },

    async getDeviceSyncState(deviceId: string) {
      return clone(
        syncStates.get(deviceId) ?? {
          deviceId,
          lastAckedSequence: 0,
          lastAckedBootId: null,
          lastSyncCompletedAt: null,
          lastOverflowDetectedAt: null,
        },
      );
    },
  };
}
