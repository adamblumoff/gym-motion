import type {
  DeviceMovementAnalyticsResult,
  MovementAnalyticsRange,
} from "@core/contracts";

import {
  deleteDeviceMovementHistory,
  getDeviceMovementAnalytics,
} from "../../../backend/data";
import type { PreferencesStore } from "../preferences-store";
import {
  invalidateCachedDeviceAnalytics,
  readCachedDeviceAnalytics,
  writeCachedDeviceAnalytics,
} from "./analytics-cache";

type AnalyticsController = {
  getDeviceAnalytics: (
    deviceId: string,
    range: MovementAnalyticsRange,
  ) => Promise<DeviceMovementAnalyticsResult>;
  refreshDeviceAnalytics: (
    deviceId: string,
    range: MovementAnalyticsRange,
  ) => Promise<DeviceMovementAnalyticsResult>;
  deleteDeviceAnalyticsHistory: (deviceId: string) => Promise<{ ok: true }>;
  invalidateDeviceAnalytics: (deviceId: string) => void;
};

export function createAnalyticsController(
  store: PreferencesStore,
): AnalyticsController {
  return {
    async getDeviceAnalytics(deviceId, range) {
      const cached = readCachedDeviceAnalytics(store, deviceId, range);

      if (cached) {
        return cached;
      }

      const fresh = await getDeviceMovementAnalytics(deviceId, range);

      if (fresh.analytics) {
        writeCachedDeviceAnalytics(store, deviceId, range, fresh.analytics);
      }

      return fresh;
    },
    async refreshDeviceAnalytics(deviceId, range) {
      const fresh = await getDeviceMovementAnalytics(deviceId, range);

      if (fresh.analytics) {
        writeCachedDeviceAnalytics(store, deviceId, range, fresh.analytics);
      } else {
        invalidateCachedDeviceAnalytics(store, deviceId);
      }

      return fresh;
    },
    async deleteDeviceAnalyticsHistory(deviceId) {
      await deleteDeviceMovementHistory(deviceId);
      invalidateCachedDeviceAnalytics(store, deviceId);
      return { ok: true };
    },
    invalidateDeviceAnalytics(deviceId) {
      invalidateCachedDeviceAnalytics(store, deviceId);
    },
  };
}
