import type {
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceSummary,
  DeviceLogSummary,
  MotionStreamPayload,
} from "@core/contracts";
import {
  mergeActivityUpdate,
  mergeEventUpdate,
  mergeGatewayDeviceUpdate,
  mergeLogUpdate,
} from "@core/contracts";
import type { DesktopRuntimeEvent } from "@core/services";

import type { DesktopDataEvent } from "../desktop-api-server";
import { mergeRepositoryDeviceIntoGatewaySnapshot } from "../gateway-snapshot";

type DataEventHandlerDeps = {
  getSnapshot: () => DesktopSnapshot;
  setSnapshot: (snapshot: DesktopSnapshot) => void;
  pruneSnapshot: (snapshot: DesktopSnapshot) => DesktopSnapshot;
  clearOptimisticMessage: (messageId: string) => {
    removedEventIds: Array<number | string>;
    removedLogIds: Array<number | string>;
    removedActivityIds: Array<number | string>;
  };
  emit: (event: DesktopRuntimeEvent) => void;
  refreshHistory: () => Promise<void>;
  refreshDeviceHistory: (deviceId: string) => Promise<void>;
  refreshSyncStateOnly: (deviceId: string) => Promise<void>;
  refreshAnalyticsNow: (deviceId: string) => void;
  scheduleAnalyticsRefresh: (deviceId: string) => void;
  recordLiveMotion: (event: MotionStreamPayload["event"]) => void;
  reportHistoryRefreshFailure: (detail: string) => void;
  clearHistoryRefreshFailure: () => void;
};

async function refreshWithRetry(work: () => Promise<void>) {
  try {
    await work();
    return;
  } catch (firstError) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await work();
    } catch {
      throw firstError;
    }
  }
}

function logBackfillEvent(message: string, details: Record<string, unknown>) {
  console.info(`[runtime] ${message}`, details);
}

export function createDataEventHandler(deps: DataEventHandlerDeps) {
  return function applyDataEvent(event: DesktopDataEvent) {
    switch (event.type) {
      case "motion-update": {
        const payload: MotionStreamPayload = event.payload;
        const clearedOptimistic = event.sourceMessageId
          ? deps.clearOptimisticMessage(event.sourceMessageId)
          : null;
        const snapshot = deps.getSnapshot();
        const device = mergeRepositoryDeviceIntoGatewaySnapshot(
          snapshot.devices,
          payload.device,
        );
        const nextSnapshot = deps.pruneSnapshot({
          ...snapshot,
          devices: mergeGatewayDeviceUpdate(snapshot.devices, device),
        });
        deps.setSnapshot(nextSnapshot);

        if (!nextSnapshot.devices.some((currentDevice) => currentDevice.id === device.id)) {
          break;
        }
        const batch: Extract<DesktopRuntimeEvent, { type: "runtime-batch" }>["patch"] = {
          devices: [device],
        };
        if (clearedOptimistic?.removedEventIds.length) {
          batch.removedEventIds = clearedOptimistic.removedEventIds;
        }
        if (clearedOptimistic?.removedActivityIds.length) {
          batch.removedActivityIds = clearedOptimistic.removedActivityIds;
        }

        if (payload.event) {
          deps.recordLiveMotion(payload.event);
          const snapshotWithEvent = deps.getSnapshot();
          deps.setSnapshot({
            ...snapshotWithEvent,
            events: mergeEventUpdate(snapshotWithEvent.events, payload.event, 14),
          });
          deps.refreshAnalyticsNow(payload.event.deviceId);
          batch.events = [payload.event];

          const activity: DeviceActivitySummary = {
            id: `motion-${payload.event.id}`,
            deviceId: payload.event.deviceId,
            sequence: payload.event.sequence,
            kind: "motion",
            title: payload.event.state.toUpperCase(),
            message: `Gateway recorded ${payload.event.state} for ${payload.event.deviceId}.`,
            state: payload.event.state,
            level: null,
            code: "motion.state",
            delta: payload.event.delta,
            eventTimestamp: payload.event.eventTimestamp,
            receivedAt: payload.event.receivedAt,
            bootId: payload.event.bootId,
            firmwareVersion: payload.event.firmwareVersion,
            hardwareId: payload.event.hardwareId,
            metadata:
              payload.event.delta === null ? null : { delta: payload.event.delta },
          };
          const snapshotWithActivity = deps.getSnapshot();
          deps.setSnapshot({
            ...snapshotWithActivity,
            activities: mergeActivityUpdate(snapshotWithActivity.activities, activity, 30),
          });
          batch.activities = [activity];
        }
        deps.emit({ type: "runtime-batch", patch: batch });

        break;
      }
      case "device-log": {
        const payload: DeviceLogSummary = event.payload;
        const clearedOptimistic = event.sourceMessageId
          ? deps.clearOptimisticMessage(event.sourceMessageId)
          : null;
        const activity: DeviceActivitySummary = {
          id: `log-${payload.id}`,
          deviceId: payload.deviceId,
          sequence: payload.sequence,
          kind: "lifecycle",
          title: payload.code ?? payload.level.toUpperCase(),
          message: payload.message,
          state: null,
          level: payload.level,
          code: payload.code,
          delta: null,
          eventTimestamp: payload.deviceTimestamp,
          receivedAt: payload.receivedAt,
          bootId: payload.bootId,
          firmwareVersion: payload.firmwareVersion,
          hardwareId: payload.hardwareId,
          metadata: payload.metadata,
        };
        deps.setSnapshot({
          ...deps.getSnapshot(),
          logs: mergeLogUpdate(deps.getSnapshot().logs, payload, 18),
          activities: mergeActivityUpdate(deps.getSnapshot().activities, activity, 30),
        });
        deps.emit({
          type: "runtime-batch",
          patch: {
            removedLogIds: clearedOptimistic?.removedLogIds,
            removedActivityIds: clearedOptimistic?.removedActivityIds,
            logs: [payload],
            activities: [activity],
          },
        });
        break;
      }
      case "device-updated":
        {
          const payload = event.payload as DeviceSummary;
          const snapshot = deps.getSnapshot();
          const device = mergeRepositoryDeviceIntoGatewaySnapshot(
            snapshot.devices,
            payload,
          );
          const nextSnapshot = deps.pruneSnapshot({
            ...snapshot,
            devices: mergeGatewayDeviceUpdate(snapshot.devices, device),
          });
          deps.setSnapshot(nextSnapshot);
          deps.emit({
            type: "runtime-batch",
            patch: {
              devices: [device],
            },
          });
        }
        break;
      case "backfill-recorded":
        logBackfillEvent("backfill recorded; updating history state", {
          deviceId: event.deviceId,
          syncComplete: event.syncComplete ?? false,
        });
        void refreshWithRetry(() =>
          event.syncComplete
            ? deps.refreshDeviceHistory(event.deviceId)
            : deps.refreshSyncStateOnly(event.deviceId),
        )
          .then(() => {
            deps.clearHistoryRefreshFailure();
            if (event.syncComplete) {
              deps.scheduleAnalyticsRefresh(event.deviceId);
            }
            logBackfillEvent("backfill history state refresh completed", {
              deviceId: event.deviceId,
              syncComplete: event.syncComplete ?? false,
            });
            deps.emit({ type: "snapshot", snapshot: deps.getSnapshot() });
          })
          .catch((error) => {
            logBackfillEvent("backfill device history refresh failed", {
              deviceId: event.deviceId,
              detail:
                error instanceof Error
                  ? error.message
                  : "History refresh failed after backfill.",
            });
            deps.reportHistoryRefreshFailure(
              error instanceof Error ? error.message : "History refresh failed after backfill.",
            );
          });
        break;
    }
  };
}
