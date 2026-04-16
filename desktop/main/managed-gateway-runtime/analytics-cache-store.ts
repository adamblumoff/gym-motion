import type { PreferencesStore } from "../preferences-store";
import type { AnalyticsWindow, DeviceAnalyticsBucket, DeviceAnalyticsSnapshot } from "@core/contracts";

const ANALYTICS_CACHE_KEY = "gym-motion.desktop.analytics-cache.v2";

export type CachedAnalyticsMap = Record<string, DeviceAnalyticsSnapshot>;

export function cacheKey(deviceId: string, window: AnalyticsWindow) {
  return `${deviceId}::${window}`;
}

function isAnalyticsWindow(value: unknown): value is AnalyticsWindow {
  return value === "24h" || value === "7d";
}

function isDeviceAnalyticsBucket(value: unknown): value is DeviceAnalyticsBucket {
  if (!value || typeof value !== "object") {
    return false;
  }

  const bucket = value as Record<string, unknown>;
  return (
    typeof bucket.key === "string" &&
    typeof bucket.label === "string" &&
    typeof bucket.startAt === "string" &&
    typeof bucket.endAt === "string" &&
    typeof bucket.movementCount === "number" &&
    typeof bucket.movingSeconds === "number"
  );
}

function isDeviceAnalyticsSnapshot(value: unknown): value is DeviceAnalyticsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.deviceId === "string" &&
    isAnalyticsWindow(snapshot.window) &&
    typeof snapshot.generatedAt === "string" &&
    (snapshot.source === "cache" || snapshot.source === "canonical") &&
    Array.isArray(snapshot.buckets) &&
    snapshot.buckets.every(isDeviceAnalyticsBucket) &&
    typeof snapshot.totalMovementCount === "number" &&
    typeof snapshot.totalMovingSeconds === "number"
  );
}

export function readAnalyticsCache(store: PreferencesStore): CachedAnalyticsMap {
  const rawCache = store.getJson<Record<string, unknown>>(ANALYTICS_CACHE_KEY) ?? {};
  const cache: CachedAnalyticsMap = {};

  for (const [key, value] of Object.entries(rawCache)) {
    if (isDeviceAnalyticsSnapshot(value)) {
      cache[key] = value;
    }
  }

  return cache;
}

export function writeAnalyticsCache(store: PreferencesStore, cache: CachedAnalyticsMap) {
  store.setJson(ANALYTICS_CACHE_KEY, cache);
}
