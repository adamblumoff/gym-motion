import type {
  DeviceMovementAnalytics,
  DeviceMovementAnalyticsResult,
  MovementAnalyticsRange,
} from "@core/contracts";

import type { PreferencesStore } from "../preferences-store";

const ANALYTICS_CACHE_KEY = "gym-motion.desktop.analytics-cache.v1";

type CachedRangeEntry = {
  analytics: DeviceMovementAnalytics;
  cachedAt: string;
};

type AnalyticsCacheState = {
  version: 1;
  devices: Record<
    string,
    Partial<Record<MovementAnalyticsRange, CachedRangeEntry>>
  >;
};

function emptyCacheState(): AnalyticsCacheState {
  return {
    version: 1,
    devices: {},
  };
}

function readCache(store: PreferencesStore) {
  const cached = store.getJson<AnalyticsCacheState>(ANALYTICS_CACHE_KEY);

  if (!cached || cached.version !== 1 || typeof cached.devices !== "object") {
    return emptyCacheState();
  }

  return cached;
}

function writeCache(store: PreferencesStore, nextState: AnalyticsCacheState) {
  store.setJson(ANALYTICS_CACHE_KEY, nextState);
}

export function readCachedDeviceAnalytics(
  store: PreferencesStore,
  deviceId: string,
  range: MovementAnalyticsRange,
): DeviceMovementAnalyticsResult | null {
  const cached = readCache(store).devices[deviceId]?.[range];

  if (!cached?.analytics) {
    return null;
  }

  return {
    analytics: cached.analytics,
    fromCache: true,
  };
}

export function writeCachedDeviceAnalytics(
  store: PreferencesStore,
  deviceId: string,
  range: MovementAnalyticsRange,
  analytics: DeviceMovementAnalytics,
) {
  const cache = readCache(store);
  const existingDevice = cache.devices[deviceId] ?? {};

  writeCache(store, {
    ...cache,
    devices: {
      ...cache.devices,
      [deviceId]: {
        ...existingDevice,
        [range]: {
          analytics,
          cachedAt: new Date().toISOString(),
        },
      },
    },
  });
}

export function invalidateCachedDeviceAnalytics(store: PreferencesStore, deviceId: string) {
  const cache = readCache(store);

  if (!cache.devices[deviceId]) {
    return;
  }

  const { [deviceId]: _removed, ...remainingDevices } = cache.devices;

  writeCache(store, {
    ...cache,
    devices: remainingDevices,
  });
}
