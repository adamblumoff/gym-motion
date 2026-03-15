import type { MotionEventSummary } from "@core/contracts";

export function buildEventBuckets(events: MotionEventSummary[]) {
  if (events.length === 0) {
    return [];
  }

  const byDevice = new Map<string, number>();
  for (const event of events) {
    byDevice.set(event.deviceId, (byDevice.get(event.deviceId) ?? 0) + 1);
  }

  return [...byDevice.entries()]
    .map(([deviceId, count]) => ({ deviceId, count }))
    .toSorted((left, right) => right.count - left.count)
    .slice(0, 6);
}
