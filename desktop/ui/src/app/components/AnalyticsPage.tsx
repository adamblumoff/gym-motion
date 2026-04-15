import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Activity, Bluetooth, Clock3, TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  mergeActivityUpdate,
  type AnalyticsWindow,
  type DeviceActivitySummary,
} from "@core/contracts";
import {
  buildAnalyticsChartData,
  buildAnalyticsOverview,
  sortAnalyticsNodes,
} from "../selectors/analytics";
import { buildBluetoothNodes as buildDashboardNodes } from "../selectors/dashboard";
import { useDesktopRuntime } from "../runtime-context";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";

function analyticsKey(deviceId: string, window: AnalyticsWindow) {
  return `${deviceId}::${window}`;
}

const ANALYTICS_WINDOWS: AnalyticsWindow[] = ["24h", "7d"];
const ACTIVITY_LIMIT = 60;

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

function signalLabel(signalStrength: number | null) {
  if (signalStrength === null) {
    return "Signal unavailable";
  }

  return `Signal ${signalStrength}%`;
}

function motionLabel(isMoving: boolean) {
  return isMoving ? "Moving now" : "Still";
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
    <Card className="border-zinc-800 bg-zinc-950/80 p-5 hover:border-zinc-700 transition-all hover:shadow-lg hover:shadow-emerald-500/5">
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
    getDeviceActivity,
  } = useDesktopRuntime();
  const [selectedWindow, setSelectedWindow] = useState<AnalyticsWindow>("24h");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);
  const [deviceActivities, setDeviceActivities] = useState<DeviceActivitySummary[]>([]);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
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
  const hasAnalytics = currentAnalytics !== null;
  const loadAnalytics = useEffectEvent((deviceId: string, window: AnalyticsWindow) =>
    getDeviceAnalytics({
      deviceId,
      window,
    }),
  );
  const loadDeviceActivity = useEffectEvent((deviceId: string) =>
    getDeviceActivity(deviceId, ACTIVITY_LIMIT),
  );

  useEffect(() => {
    if (!selectedNodeId) {
      return;
    }
    if (hasAnalytics) {
      setIsLoadingAnalytics(false);
      return;
    }

    let cancelled = false;
    setIsLoadingAnalytics(true);

    void loadAnalytics(selectedNodeId, selectedWindow).finally(() => {
      if (!cancelled) {
        setIsLoadingAnalytics(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hasAnalytics, loadAnalytics, selectedNodeId, selectedWindow]);

  useEffect(() => {
    if (!selectedNodeId) {
      setDeviceActivities([]);
      return;
    }

    let cancelled = false;
    setIsLoadingActivity(true);

    void loadDeviceActivity(selectedNodeId)
      .then((activities) => {
        if (!cancelled) {
          setDeviceActivities(activities);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingActivity(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    loadDeviceActivity,
    selectedNodeId,
  ]);

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
  const activityLogs = useMemo(() => {
    if (!selectedNodeId) {
      return [];
    }

    let activities = deviceActivities;
    for (const activity of snapshot?.activities ?? []) {
      if (activity.deviceId !== selectedNodeId) {
        continue;
      }

      activities = mergeActivityUpdate(activities, activity, ACTIVITY_LIMIT);
    }

    return activities.map((activity) => ({
      id: activity.id,
      timestamp: new Date(activity.receivedAt),
      message: activity.message,
      isMoving: activity.state === "moving",
    }));
  }, [deviceActivities, selectedNodeId, snapshot?.activities]);
  const utilizationSummary = useMemo(() => {
    if (isLoadingAnalytics && !overview) {
      return "Loading machine utilization...";
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
      <div className="flex-1 flex flex-col">
        <div className="p-6">
          <h1 className="text-xl font-semibold text-zinc-100">Analytics</h1>
          <p className="text-sm text-zinc-500">How often each machine is actually in use</p>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <Card className="max-w-xl border-zinc-800 bg-zinc-950/80 p-8 text-center">
            <p className="text-sm text-zinc-300">No approved nodes are available for analytics yet.</p>
            <p className="mt-2 text-sm text-zinc-500">
              Pair a node from Setup, then return here to view live motion analytics.
              Pair a node from Setup, then return here to view movement analytics.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Analytics</h1>
        <p className="text-sm text-zinc-500">How often each machine is actually in use</p>
      </div>
        <div className="mx-auto max-w-[1800px] space-y-6">
          <Card className="border-zinc-800 bg-zinc-950/80 p-5 hover:border-zinc-700 transition-colors">
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

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.8fr)_repeat(3,minmax(0,1fr))]">
            <Card className="group border-zinc-800 bg-zinc-950/80 p-6 hover:border-zinc-700 transition-all hover:shadow-lg hover:shadow-emerald-500/5">
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
                  <TrendingUp className="size-6 text-emerald-300 group-hover:-translate-y-0.5 group-hover:scale-105 transition-transform duration-300" />
                </div>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.3em] text-zinc-500">
                  <span>Utilization Meter</span>
                  <span>{overview?.movementStarts ?? 0} starts</span>
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-zinc-900 group-hover:shadow-[0_0_8px_rgba(52,211,153,0.15)] transition-shadow duration-300">
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

          <Card className="border-zinc-800 bg-zinc-950/60 p-5 hover:border-zinc-700 transition-colors">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Data Status</p>
                <p className="mt-2 text-sm text-zinc-400">
                  Live connection stays visible here while usage remains the primary signal.
                </p>
                <div className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
                  <span className="size-2 rounded-full bg-emerald-300" />
                  <span>Analytics come from live persisted motion transitions.</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Badge
                  variant="outline"
                  className="border-zinc-800 bg-zinc-950 text-zinc-300"
                >
                  {motionLabel(selectedNode.isMoving)}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-zinc-800 bg-zinc-950 text-zinc-300"
                >
                  {signalLabel(selectedNode.signalStrength)}
                </Badge>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.7fr_1fr]">
            <Card className="border-zinc-800 bg-zinc-950/80 p-6 hover:border-zinc-700 transition-colors">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Usage Over Time</h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Active minutes per {selectedWindow === "24h" ? "hour" : "day"}
                </p>
              </div>
              {chartData.length > 0 ? (
                <AreaChart
                  data={chartData}
                  height={280}
                  responsive
                  style={{ width: "100%", maxWidth: "100%" }}
                >
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
                    isAnimationActive={false}
                  />
                </AreaChart>
              ) : (
                <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-500">
                  {isLoadingAnalytics
                    ? "Loading live analytics…"
                    : "No recorded use in this window yet."}
                </div>
              )}
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/80 p-6 hover:border-zinc-700 transition-colors">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Session Starts</h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Movement starts per {selectedWindow === "24h" ? "hour" : "day"}
                </p>
              </div>
              {chartData.length > 0 ? (
                <BarChart
                  data={chartData}
                  height={280}
                  responsive
                  style={{ width: "100%", maxWidth: "100%" }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="label" stroke="#52525b" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <YAxis stroke="#52525b" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="movements"
                    name="Movement starts"
                    fill="#f59e0b"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              ) : (
                <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-500">
                  {isLoadingAnalytics
                    ? "Loading session starts…"
                    : "Movement starts will appear here once live motion transitions are recorded."}
                </div>
              )}
            </Card>
          </div>

          <Card className="border-zinc-800 bg-zinc-950/80 p-6 hover:border-zinc-700 transition-colors">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-sm font-medium text-zinc-100">Live Activity</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Recent runtime events for this machine, shared with the dashboard feed.
                </p>
              </div>
              <Badge
                variant="outline"
                className="border-zinc-800 bg-zinc-950 text-zinc-300"
              >
                {activityLogs.length} recent events
              </Badge>
            </div>

            <ScrollArea className="mt-5 h-56">
              <div className="space-y-2 pr-4">
                {activityLogs.length > 0 ? (
                  activityLogs.map((log) => (
                    <div
                      key={log.id}
                      className="flex items-start gap-3 rounded-lg border border-zinc-900 bg-zinc-950/70 px-3 py-2 hover:bg-zinc-900/80 hover:border-zinc-800 transition-colors"
                    >
                      <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                        {log.timestamp.toLocaleTimeString("en-US", {
                          hour12: false,
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span className={log.isMoving ? "text-blue-300" : "text-zinc-400"}>
                        {log.message}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-500">
                    {isLoadingActivity
                      ? "Loading machine activity…"
                      : "Machine activity will appear here as live motion events and device logs arrive."}
                  </div>
                )}
              </div>
            </ScrollArea>
          </Card>
        </div>
    </div>
  );
}

