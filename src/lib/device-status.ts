import type { HealthStatus } from "@/lib/motion";

const ONLINE_THRESHOLD_MS = 45_000;
const STALE_THRESHOLD_MS = 2 * 60_000;

export function deriveHealthStatus(lastContactAt: string | null): HealthStatus {
  if (!lastContactAt) {
    return "offline";
  }

  const lastContactMs = new Date(lastContactAt).getTime();

  if (Number.isNaN(lastContactMs)) {
    return "offline";
  }

  const ageMs = Date.now() - lastContactMs;

  // Future timestamps indicate bad source data. Treat them as offline instead
  // of pinning a dead device to "online" forever.
  if (ageMs < -5_000) {
    return "offline";
  }

  const normalizedAgeMs = Math.max(ageMs, 0);

  if (normalizedAgeMs <= ONLINE_THRESHOLD_MS) {
    return "online";
  }

  if (normalizedAgeMs <= STALE_THRESHOLD_MS) {
    return "stale";
  }

  return "offline";
}
