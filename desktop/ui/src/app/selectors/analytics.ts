import type { MotionEventSummary } from "@core/contracts";

import type {
  BluetoothNodeData,
  MovementDataPoint,
  SignalHistoryData,
  SignalHistoryPoint,
  SignalHistorySeries,
} from "./types";

const SIGNAL_SERIES_COLORS = [
  "#3b82f6",
  "#06b6d4",
  "#8b5cf6",
  "#22c55e",
  "#f97316",
];

function signalSeriesId(deviceId: string) {
  return `device:${deviceId}`;
}

function activeSignalSeries(nodes: BluetoothNodeData[]): SignalHistorySeries[] {
  return [...nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 5)
    .map((node, index) => ({
      id: signalSeriesId(node.id),
      deviceId: node.id,
      name: node.name,
      color: SIGNAL_SERIES_COLORS[index] ?? SIGNAL_SERIES_COLORS[0],
    }));
}

export function buildSignalHistory(
  events: MotionEventSummary[],
  nodes: BluetoothNodeData[],
): SignalHistoryData {
  const series = activeSignalSeries(nodes);
  const sortedEvents = [...events].sort(
    (left, right) => left.eventTimestamp - right.eventTimestamp,
  );
  const eventsByDeviceId = new Map<string, MotionEventSummary[]>();

  for (const event of sortedEvents) {
    const existing = eventsByDeviceId.get(event.deviceId) ?? [];
    existing.push(event);
    eventsByDeviceId.set(event.deviceId, existing);
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));

  const points = sortedEvents.map((event) => {
    const bucket: SignalHistoryPoint = {
      time: new Date(event.eventTimestamp).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    series.forEach((signalSeries) => {
      const node = nodesById.get(signalSeries.deviceId);
      const fallbackSignal = node?.signalStrength ?? 0;
      const activeEvents = eventsByDeviceId.get(signalSeries.deviceId) ?? [];
      let eventForNode: MotionEventSummary | null = null;

      for (const candidate of activeEvents) {
        if (candidate.eventTimestamp > event.eventTimestamp) {
          break;
        }

        eventForNode = candidate;
      }

      const level = eventForNode
        ? Math.max(8, Math.min(100, (eventForNode.delta ?? fallbackSignal) + 25))
        : fallbackSignal;
      bucket[signalSeries.id] = level;
    });

    return bucket;
  });

  return {
    series,
    points,
  };
}

export function buildMovementData(events: MotionEventSummary[]): MovementDataPoint[] {
  const byHour = new Map<string, number>();

  for (const event of events) {
    const hour = new Date(event.eventTimestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
    });
    const key = `${hour}:00`;
    byHour.set(key, (byHour.get(key) ?? 0) + 1);
  }

  return [...byHour.entries()]
    .map(([hour, movements]) => ({ hour, movements }))
    .sort((left, right) => left.hour.localeCompare(right.hour));
}

export function calculateAverageSignal(
  latestSignal: SignalHistoryPoint | null,
  series: SignalHistorySeries[],
) {
  const signalValues = latestSignal
    ? series
        .map((signalSeries) => latestSignal[signalSeries.id])
        .filter((value): value is number => typeof value === "number" && value > 0)
    : [];

  return Math.round(
    signalValues.length > 0
      ? signalValues.reduce((sum, value) => sum + value, 0) / signalValues.length
      : 0,
  );
}
