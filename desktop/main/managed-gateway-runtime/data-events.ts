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
  emit: (event: DesktopRuntimeEvent) => void;
  refreshHistory: () => Promise<void>;
  scheduleAnalyticsRefresh: (deviceId: string) => void;
};

export function createDataEventHandler(deps: DataEventHandlerDeps) {
  return function applyDataEvent(event: DesktopDataEvent) {
    switch (event.type) {
      case "motion-update": {
        const payload: MotionStreamPayload = event.payload;
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

        deps.emit({
          type: "device-upserted",
          device,
        });

        if (payload.event) {
          deps.setSnapshot({
            ...deps.getSnapshot(),
            events: mergeEventUpdate(deps.getSnapshot().events, payload.event, 14),
          });
          deps.emit({ type: "event-recorded", event: payload.event });
          deps.scheduleAnalyticsRefresh(payload.event.deviceId);

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
          deps.setSnapshot({
            ...deps.getSnapshot(),
            activities: mergeActivityUpdate(deps.getSnapshot().activities, activity, 30),
          });
          deps.emit({ type: "activity-recorded", activity });
        }

        break;
      }
      case "device-log": {
        const payload: DeviceLogSummary = event.payload;
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
        deps.emit({ type: "log-recorded", log: payload });
        deps.emit({ type: "activity-recorded", activity });
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
          deps.emit({ type: "device-upserted", device });
        }
        break;
      case "backfill-recorded":
        deps.scheduleAnalyticsRefresh(event.deviceId);
        void deps.refreshHistory().then(() => {
          deps.emit({ type: "snapshot", snapshot: deps.getSnapshot() });
        });
        break;
    }
  };
}
