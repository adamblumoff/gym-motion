import type {
  DeviceAnalyticsSnapshot,
  GatewayConnectionState,
} from "@core/contracts";

import type { BluetoothNodeData } from "./types";

export type AnalyticsChartPoint = {
  label: string;
  movements: number;
  movingMinutes: number;
};

function connectionRank(connectionState: GatewayConnectionState) {
  switch (connectionState) {
    case "connected":
      return 0;
    case "connecting":
    case "reconnecting":
      return 1;
    case "disconnected":
      return 2;
    case "discovered":
      return 3;
    case "unreachable":
    default:
      return 4;
  }
}

export function sortAnalyticsNodes(nodes: BluetoothNodeData[]) {
  return [...nodes].sort((left, right) => {
    const rankDifference = connectionRank(left.connectionState) - connectionRank(right.connectionState);
    if (rankDifference !== 0) {
      return rankDifference;
    }

    return left.name.localeCompare(right.name);
  });
}

export function buildAnalyticsChartData(
  analytics: DeviceAnalyticsSnapshot | null,
): AnalyticsChartPoint[] {
  if (!analytics) {
    return [];
  }

  return analytics.buckets.map((bucket) => ({
    label: bucket.label,
    movements: bucket.movementCount,
    movingMinutes: Math.round((bucket.movingSeconds / 60) * 10) / 10,
  }));
}

export function formatMovingDuration(totalMovingSeconds: number) {
  const totalMinutes = Math.round(totalMovingSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}
