import {
  analyticsWindows,
  buildAnalyticsSnapshot,
  findLatestDeviceMotionEventBeforeReceivedAt,
  hasMotionRollupTables,
  listDeviceMotionEventsByReceivedAt,
  listMotionRollupBuckets,
  summarizeMotionEventsInBuckets,
} from "../../../backend/data";
import type { PreferencesStore } from "../preferences-store";
import type {
  DeviceAnalyticsSnapshot,
  GatewayRuntimeDeviceSummary,
  GetDeviceAnalyticsInput,
  MotionEventSummary,
} from "@core/contracts";
import {
  cacheKey,
  readAnalyticsCache,
  writeAnalyticsCache,
} from "./analytics-cache-store";
import {
  mergeLiveOverlayIntoSnapshot,
  pruneLiveMotionEvents,
} from "./analytics-live-overlay";

type AnalyticsServiceDeps = {
  store: PreferencesStore;
  getRuntimeDevice: (deviceId: string) => GatewayRuntimeDeviceSummary | null;
  onUpdated: (analytics: DeviceAnalyticsSnapshot) => void;
  hasMotionRollupTables?: typeof hasMotionRollupTables;
  listMotionRollupBuckets?: typeof listMotionRollupBuckets;
  listDeviceMotionEventsByReceivedAt?: typeof listDeviceMotionEventsByReceivedAt;
  findLatestDeviceMotionEventBeforeReceivedAt?: typeof findLatestDeviceMotionEventBeforeReceivedAt;
};
export { summarizeMotionEventsInBuckets };

export type AnalyticsService = {
  getDeviceAnalytics: (input: GetDeviceAnalyticsInput) => Promise<DeviceAnalyticsSnapshot>;
  scheduleRefresh: (deviceId: string, delayMs?: number) => void;
  recordLiveMotion: (event: MotionEventSummary) => void;
};

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const liveMotionEvents = new Map<string, MotionEventSummary[]>();
  const checkHasMotionRollups = deps.hasMotionRollupTables ?? hasMotionRollupTables;
  const loadMotionRollupBuckets = deps.listMotionRollupBuckets ?? listMotionRollupBuckets;
  const loadMotionEventsByReceivedAt =
    deps.listDeviceMotionEventsByReceivedAt ?? listDeviceMotionEventsByReceivedAt;
  const loadLatestMotionEventBeforeReceivedAt =
    deps.findLatestDeviceMotionEventBeforeReceivedAt ??
    findLatestDeviceMotionEventBeforeReceivedAt;

  function emitMergedCachedSnapshots(deviceId: string) {
    const cache = readAnalyticsCache(deps.store);
    for (const window of analyticsWindows()) {
      const cached = cache[cacheKey(deviceId, window)];
      if (!cached) {
        continue;
      }

      deps.onUpdated(mergeLiveOverlayIntoSnapshot(cached, liveMotionEvents.get(deviceId) ?? []));
    }
  }

  async function refreshDevice(deviceId: string) {
    const nextCache = {
      ...readAnalyticsCache(deps.store),
    };

    for (const window of analyticsWindows()) {
      const analytics = await buildAnalyticsSnapshot({
        deviceId,
        window,
        hasMotionRollupTables: checkHasMotionRollups,
        listMotionRollupBuckets: loadMotionRollupBuckets,
        listDeviceMotionEventsByReceivedAt: loadMotionEventsByReceivedAt,
        findLatestDeviceMotionEventBeforeReceivedAt:
          loadLatestMotionEventBeforeReceivedAt,
      });
      nextCache[cacheKey(deviceId, window)] = analytics;
      deps.onUpdated(mergeLiveOverlayIntoSnapshot(analytics, liveMotionEvents.get(deviceId) ?? []));
    }

    writeAnalyticsCache(deps.store, nextCache);
  }

  function scheduleRefresh(deviceId: string, delayMs = 150) {
    const existing = refreshTimers.get(deviceId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      refreshTimers.delete(deviceId);
      void refreshDevice(deviceId).catch((error) => {
        console.error("[runtime] analytics refresh failed", error);
      });
    }, delayMs);
    timer.unref?.();
    refreshTimers.set(deviceId, timer);
  }

  return {
    async getDeviceAnalytics(input) {
      const cache = readAnalyticsCache(deps.store);
      const cached = cache[cacheKey(input.deviceId, input.window)];

      if (cached) {
        scheduleRefresh(input.deviceId);
        return mergeLiveOverlayIntoSnapshot(
          {
            ...cached,
            source: "cache",
          },
          liveMotionEvents.get(input.deviceId) ?? [],
        );
      }

      const analytics = await buildAnalyticsSnapshot({
        deviceId: input.deviceId,
        window: input.window,
        hasMotionRollupTables: checkHasMotionRollups,
        listMotionRollupBuckets: loadMotionRollupBuckets,
        listDeviceMotionEventsByReceivedAt: loadMotionEventsByReceivedAt,
        findLatestDeviceMotionEventBeforeReceivedAt:
          loadLatestMotionEventBeforeReceivedAt,
      });

      writeAnalyticsCache(deps.store, {
        ...cache,
        [cacheKey(input.deviceId, input.window)]: analytics,
      });

      return mergeLiveOverlayIntoSnapshot(analytics, liveMotionEvents.get(input.deviceId) ?? []);
    },

    scheduleRefresh,

    recordLiveMotion(event) {
      const current = liveMotionEvents.get(event.deviceId) ?? [];
      const nextEvents = [...current, event].sort(
        (left, right) =>
          Date.parse(left.receivedAt) - Date.parse(right.receivedAt) || left.id - right.id,
      );
      liveMotionEvents.set(event.deviceId, nextEvents);
      pruneLiveMotionEvents(liveMotionEvents, event.deviceId, Date.now());
      emitMergedCachedSnapshots(event.deviceId);
    },
  };
}
