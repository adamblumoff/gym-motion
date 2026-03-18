import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, Bluetooth, Clock3, DatabaseZap, TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { AnalyticsWindow } from "@core/contracts";
import {
  buildAnalyticsChartData,
  buildAnalyticsOverview,
  sortAnalyticsNodes,
} from "../selectors/analytics";
import { buildBluetoothNodes as buildDashboardNodes } from "../selectors/dashboard";
import { useDesktopRuntime } from "../runtime-context";
import { PageHeader } from "./PageHeader";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

function analyticsKey(deviceId: string, window: AnalyticsWindow) {
  return `${deviceId}::${window}`;
}

const ANALYTICS_WINDOWS: AnalyticsWindow[] = ["24h", "7d"];

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/95 px-3 py-2 shadow-2xl">
      <p className="mb-1 text-xs text-zinc-400">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.name} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: {entry.value}
          {entry.dataKey === "movingMinutes" ? " min" : ""}
        </p>
      ))}
    </div>
  );
};

function connectionLabel(connectionState: string) {
  switch (connectionState) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "connecting":
      return "Connecting";
    case "disconnected":
      return "Disconnected";
    case "unreachable":
      return "Unreachable";
    default:
      return "Discovered";
  }
}

function syncBannerCopy(state: "idle" | "syncing" | "failed", detail: string | null) {
  if (state === "syncing") {
    return "History catch-up is running in the background. Cached analytics stays visible while canonical history catches up.";
  }

  if (state === "failed") {
    return detail ?? "History sync failed. Cached analytics remains available until the next successful refresh.";
  }

  return null;
}

function syncStateLabel(state: "idle" | "syncing" | "failed") {
  switch (state) {
    case "syncing":
      return "Syncing";
    case "failed":
      return "Needs attention";
    case "idle":
    default:
      return "Up to date";
  }
}

function signalLabel(signalStrength: number | null) {
  if (signalStrength === null) {
    return "Signal unavailable";
  }

  return `Signal ${signalStrength}%`;
}

type SummaryMetricCardProps = {
  icon: LucideIcon;
  iconClassName: string;
  label: string;
  value: string;
  description: string;
};

function SummaryMetricCard({
  icon: Icon,
  iconClassName,
  label,
  value,
  description,
}: SummaryMetricCardProps) {
  return (
    <Card className="border-zinc-800 bg-zinc-950/80 p-5">
      <div className="mb-4 flex items-center justify-between">
        <Icon className={`size-5 ${iconClassName}`} />
        <span className="text-xs uppercase tracking-[0.3em] text-zinc-500">{label}</span>
      </div>
      <div className="text-3xl font-mono text-zinc-100">{value}</div>
      <div className="mt-2 text-xs text-zinc-500">{description}</div>
    </Card>
  );
}

export function AnalyticsPage() {
  const {
    snapshot,
    analyticsByKey,
    getDeviceAnalytics,
  } = useDesktopRuntime();
  const [selectedWindow, setSelectedWindow] = useState<AnalyticsWindow>("24h");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);
  const nodes = useMemo(
    () => sortAnalyticsNodes(snapshot ? buildDashboardNodes(snapshot) : []),
    [snapshot],
  );

  useEffect(() => {
    if (nodes.length === 0) {
      setSelectedNodeId(null);
      return;
    }

    setSelectedNodeId((current) => {
      if (current && nodes.some((node) => node.id === current)) {
        return current;
      }

      return nodes[0]?.id ?? null;
    });
  }, [nodes]);

  const currentAnalytics = selectedNodeId
    ? analyticsByKey[analyticsKey(selectedNodeId, selectedWindow)] ?? null
    : null;
  const loadAnalytics = useEffectEvent((deviceId: string, window: AnalyticsWindow) =>
    getDeviceAnalytics({
      deviceId,
      window,
    }),
  );
  const readCachedAnalytics = useEffectEvent((deviceId: string, window: AnalyticsWindow) =>
    analyticsByKey[analyticsKey(deviceId, window)] ?? null,
  );

  useEffect(() => {
    if (!selectedNodeId) {
      return;
    }

    let cancelled = false;
    setIsLoadingAnalytics(readCachedAnalytics(selectedNodeId, selectedWindow) === null);

    void loadAnalytics(selectedNodeId, selectedWindow).finally(() => {
      if (!cancelled) {
        setIsLoadingAnalytics(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadAnalytics, readCachedAnalytics, selectedNodeId, selectedWindow]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );
  const chartData = useMemo(
    () => buildAnalyticsChartData(currentAnalytics),
    [currentAnalytics],
  );
  const overview = useMemo(
    () => buildAnalyticsOverview(currentAnalytics),
    [currentAnalytics],
  );
  const syncBanner = currentAnalytics
    ? syncBannerCopy(currentAnalytics.sync.state, currentAnalytics.sync.detail)
    : null;
  const utilizationSummary = useMemo(() => {
    if (isLoadingAnalytics && !overview) {
      return "Loading utilization from canonical history...";
    }

    if (!overview) {
      return "No recorded use in the selected window yet.";
    }

    if (!overview.hasRecordedUse) {
      return `No recorded use in the ${overview.windowLabel}.`;
    }

    return `${overview.activeTimeLabel} active in the ${overview.windowLabel}.`;
  }, [isLoadingAnalytics, overview]);

  if (!selectedNode) {
    return (
      <div className="size-full flex flex-col bg-black">
        <PageHeader
          title="Analytics"
          description="How often each machine is actually in use"
          icon={TrendingUp}
          backHref="/"
          backLabel="Back to Dashboard"
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <Card className="max-w-xl border-zinc-800 bg-zinc-950/80 p-8 text-center">
            <p className="text-sm text-zinc-300">No approved nodes are available for analytics yet.</p>
            <p className="mt-2 text-sm text-zinc-500">
              Pair a node from Setup, then return here to view cached and canonical movement history.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="size-full flex flex-col bg-black">
      <PageHeader
        title="Analytics"
        description="How often each machine is actually in use"
        icon={TrendingUp}
        backHref="/"
        backLabel="Back to Dashboard"
        rightSlot={(
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="border-zinc-800 bg-zinc-950 text-zinc-300"
            >
              {connectionLabel(selectedNode.connectionState)}
            </Badge>
            {currentAnalytics ? (
              <Badge
                variant="outline"
                className="border-zinc-800 bg-zinc-950 text-zinc-300"
              >
                {currentAnalytics.source === "cache" ? "Cached snapshot" : "Canonical snapshot"}
              </Badge>
            ) : null}
          </div>
        )}
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-[1800px] space-y-6">
          <Card className="border-zinc-800 bg-zinc-950/80 p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Selected Machine</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {nodes.map((node) => {
                    const active = node.id === selectedNode.id;
                    return (
                      <Button
                        key={node.id}
                        type="button"
                        variant={active ? "default" : "outline"}
                        className={
                          active
                            ? "bg-amber-400 text-zinc-950 hover:bg-amber-300"
                            : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900"
                        }
                        onClick={() => setSelectedNodeId(node.id)}
                      >
                        <Bluetooth className="size-4" />
                        {node.name}
                        <span className="text-[11px] opacity-70">
                          {connectionLabel(node.connectionState)}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Window</p>
                <div className="mt-2 flex items-center gap-2">
                  {ANALYTICS_WINDOWS.map((window) => (
                    <Button
                      key={window}
                      type="button"
                      variant={selectedWindow === window ? "default" : "outline"}
                      className={
                        selectedWindow === window
                          ? "bg-blue-500 text-white hover:bg-blue-400"
                          : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-900"
                      }
                      onClick={() => setSelectedWindow(window)}
                    >
                      {window}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          {syncBanner ? (
            <Card className="border-amber-500/30 bg-amber-500/10 p-4">
              <div className="flex items-start gap-3">
                <DatabaseZap className="mt-0.5 size-4 text-amber-300" />
                <div>
                  <p className="text-sm font-medium text-amber-100">
                    {currentAnalytics?.sync.state === "failed" ? "History sync needs attention" : "History catch-up in progress"}
                  </p>
                  <p className="mt-1 text-sm text-amber-200/80">{syncBanner}</p>
                </div>
              </div>
            </Card>
          ) : null}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.8fr)_repeat(3,minmax(0,1fr))]">
            <Card className="border-zinc-800 bg-zinc-950/80 p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Utilization</p>
                  <div className="mt-4 flex flex-wrap items-end gap-x-3 gap-y-1">
                    <span className="text-5xl font-mono leading-none text-zinc-100">
                      {overview?.utilizationPercent ?? 0}%
                    </span>
                    <span className="pb-1 text-sm text-zinc-400">of selected window</span>
                  </div>
                  <p className="mt-3 max-w-2xl text-sm text-zinc-400">{utilizationSummary}</p>
                </div>
                <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-3">
                  <TrendingUp className="size-6 text-emerald-300" />
                </div>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.3em] text-zinc-500">
                  <span>Utilization Meter</span>
                  <span>{overview?.movementStarts ?? 0} starts</span>
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-zinc-900">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-300 via-cyan-300 to-blue-300 transition-[width] duration-500"
                    style={{ width: `${overview?.utilizationPercent ?? 0}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
                  <span>0%</span>
                  <span>Share of the selected window spent moving</span>
                  <span>100%</span>
                </div>
              </div>
            </Card>

            <SummaryMetricCard
              icon={Clock3}
              iconClassName="text-cyan-300"
              label="Active Time"
              value={overview?.activeTimeLabel ?? "0m"}
              description="Total moving time recorded in this window"
            />

            <SummaryMetricCard
              icon={Activity}
              iconClassName="text-amber-300"
              label="Movement Starts"
              value={String(overview?.movementStarts ?? 0)}
              description="Canonical sessions started in this window"
            />

            <SummaryMetricCard
              icon={TrendingUp}
              iconClassName="text-emerald-300"
              label="Busiest Period"
              value={overview?.busiestPeriodLabel ?? "No use yet"}
              description={
                overview?.busiestPeriodDurationLabel
                  ? `${overview.busiestPeriodDurationLabel} of movement in the busiest ${selectedWindow === "24h" ? "hour" : "day"}`
                  : `Waiting for the busiest ${selectedWindow === "24h" ? "hour" : "day"} to emerge`
              }
            />
          </div>

          <Card className="border-zinc-800 bg-zinc-950/60 p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Data Status</p>
                <p className="mt-2 text-sm text-zinc-400">
                  Live connection and history sync stay visible here while usage remains the primary signal.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Badge
                  variant="outline"
                  className="border-zinc-800 bg-zinc-950 text-zinc-300"
                >
                  {syncStateLabel(currentAnalytics?.sync.state ?? "idle")}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-zinc-800 bg-zinc-950 text-zinc-300"
                >
                  {signalLabel(selectedNode.signalStrength)}
                </Badge>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3 border-t border-zinc-900 pt-4 lg:flex-row lg:items-center lg:justify-between">
              <p className="text-xs text-zinc-500">
                {currentAnalytics?.sync.lastSyncCompletedAt
                  ? `Last completed sync ${new Date(currentAnalytics.sync.lastSyncCompletedAt).toLocaleString()}`
                  : "No completed sync recorded yet"}
              </p>

              {currentAnalytics?.warningFlags.length ? (
                <div className="flex flex-wrap gap-2">
                  {currentAnalytics.warningFlags.map((warning) => (
                    <Badge
                      key={warning}
                      variant="outline"
                      className="border-zinc-800 bg-zinc-900 text-zinc-300"
                    >
                      {warning}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.7fr_1fr]">
            <Card className="border-zinc-800 bg-zinc-950/80 p-6">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Usage Over Time</h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Active minutes per {selectedWindow === "24h" ? "hour" : "day"}
                </p>
              </div>
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="label" stroke="#52525b" tick={{ fill: "#71717a", fontSize: 11 }} />
                    <YAxis stroke="#52525b" tick={{ fill: "#71717a", fontSize: 11 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="movingMinutes"
                      name="Moving minutes"
                      stroke="#22d3ee"
                      fill="#22d3ee"
                      fillOpacity={0.15}
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-500">
                  {isLoadingAnalytics
                    ? "Loading usage history…"
                    : "No recorded use in this window yet."}
                </div>
              )}
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/80 p-6">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Session Starts</h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Movement starts per {selectedWindow === "24h" ? "hour" : "day"}
                </p>
              </div>
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="label" stroke="#52525b" tick={{ fill: "#71717a", fontSize: 11 }} />
                    <YAxis stroke="#52525b" tick={{ fill: "#71717a", fontSize: 11 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="movements" name="Movement starts" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-500">
                  {isLoadingAnalytics
                    ? "Loading session starts…"
                    : "Movement starts will appear once canonical history is available."}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
