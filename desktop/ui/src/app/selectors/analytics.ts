import type {
  AnalyticsWindow,
  DeviceAnalyticsSnapshot,
  GatewayConnectionState,
} from "@core/contracts";

import type { BluetoothNodeData } from "./types";

export type AnalyticsChartPoint = {
  label: string;
  movements: number;
  movingMinutes: number;
};

export type AnalyticsOverview = {
  utilizationPercent: number;
  activeTimeLabel: string;
  windowLabel: string;
  hasRecordedUse: boolean;
  movementStarts: number;
  busiestPeriodLabel: string | null;
  busiestPeriodDurationLabel: string | null;
};

export type AnalyticsSyncDisplay = {
  label: string;
  detail: string | null;
  tone: "neutral" | "warning" | "muted";
  showAnimation: boolean;
};

const ANALYTICS_WINDOW_SECONDS: Record<AnalyticsWindow, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
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

function formatWindowLabel(window: AnalyticsWindow) {
  return window === "24h" ? "last 24h" : "last 7d";
}

function formatBusiestPeriodLabel(snapshot: DeviceAnalyticsSnapshot, startAt: string, endAt: string) {
  if (snapshot.window === "24h") {
    const startLabel = new Date(startAt).toLocaleTimeString("en-US", {
      hour: "numeric",
    });
    const endLabel = new Date(endAt).toLocaleTimeString("en-US", {
      hour: "numeric",
    });

    return `${startLabel} - ${endLabel}`;
  }

  return new Date(startAt).toLocaleDateString("en-US", {
    weekday: "long",
  });
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

export function buildAnalyticsOverview(
  analytics: DeviceAnalyticsSnapshot | null,
): AnalyticsOverview | null {
  if (!analytics) {
    return null;
  }

  const durationSeconds = ANALYTICS_WINDOW_SECONDS[analytics.window];
  const utilizationPercent = Math.min(
    100,
    Math.max(0, Math.round((analytics.totalMovingSeconds / durationSeconds) * 100)),
  );
  const busiestBucket = analytics.buckets.reduce<DeviceAnalyticsSnapshot["buckets"][number] | null>(
    (currentBest, bucket) => {
      if (!currentBest) {
        return bucket;
      }

      if (bucket.movingSeconds !== currentBest.movingSeconds) {
        return bucket.movingSeconds > currentBest.movingSeconds ? bucket : currentBest;
      }

      if (bucket.movementCount !== currentBest.movementCount) {
        return bucket.movementCount > currentBest.movementCount ? bucket : currentBest;
      }

      return currentBest;
    },
    null,
  );
  const hasRecordedUse =
    analytics.totalMovingSeconds > 0 ||
    analytics.totalMovementCount > 0 ||
    (!!busiestBucket &&
      (busiestBucket.movingSeconds > 0 || busiestBucket.movementCount > 0));

  return {
    utilizationPercent,
    activeTimeLabel: formatMovingDuration(analytics.totalMovingSeconds),
    windowLabel: formatWindowLabel(analytics.window),
    hasRecordedUse,
    movementStarts: analytics.totalMovementCount,
    busiestPeriodLabel:
      hasRecordedUse && busiestBucket
        ? formatBusiestPeriodLabel(analytics, busiestBucket.startAt, busiestBucket.endAt)
        : null,
    busiestPeriodDurationLabel:
      hasRecordedUse && busiestBucket
        ? formatMovingDuration(Math.round(busiestBucket.movingSeconds))
        : null,
  };
}

export function buildAnalyticsSyncDisplay(
  analytics: DeviceAnalyticsSnapshot | null,
): AnalyticsSyncDisplay | null {
  if (!analytics) {
    return null;
  }

  switch (analytics.sync.state) {
    case "syncing":
      return {
        label: "Syncing history",
        detail:
          "Live updates stay current while analytics catches up in the background.",
        tone: "muted",
        showAnimation: true,
      };
    case "failed":
      return {
        label: "History sync failed",
        detail:
          analytics.sync.detail ??
          "Waiting for the next successful history refresh.",
        tone: "warning",
        showAnimation: false,
      };
    case "idle":
    default:
      return {
        label: "History up to date",
        detail: null,
        tone: "neutral",
        showAnimation: false,
      };
  }
}
