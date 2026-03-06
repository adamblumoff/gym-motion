import type { HealthStatus } from "@/lib/motion";

const ONLINE_THRESHOLD_MS = 45_000;
const STALE_THRESHOLD_MS = 2 * 60_000;

export function deriveHealthStatus(lastContactAt: string | null): HealthStatus {
  if (!lastContactAt) {
    return "offline";
  }

  const ageMs = Date.now() - new Date(lastContactAt).getTime();

  if (ageMs <= ONLINE_THRESHOLD_MS) {
    return "online";
  }

  if (ageMs <= STALE_THRESHOLD_MS) {
    return "stale";
  }

  return "offline";
}
