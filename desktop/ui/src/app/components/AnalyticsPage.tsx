import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Clock3,
  RefreshCcw,
  ShieldAlert,
  TimerReset,
  Trash2,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Toaster, toast } from "sonner";

import type {
  DeviceMovementAnalytics,
  DeviceMovementAnalyticsResult,
  MovementAnalyticsRange,
} from "@core/contracts";

import {
  buildLiveMovementAnalytics,
  combineMovementAnalytics,
  formatDurationLabel,
  summarizeMovementChart,
} from "../selectors/analytics";
import { buildBluetoothNodes } from "../selectors/dashboard";
import { useDesktopRuntime } from "../runtime-context";
import { PageHeader } from "./PageHeader";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

const RANGE_OPTIONS: MovementAnalyticsRange[] = ["24h", "7d"];

const RANGE_LABELS: Record<MovementAnalyticsRange, string> = {
  "24h": "Last 24 Hours",
  "7d": "Last 7 Days",
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/95 px-3 py-2 shadow-2xl">
      <p className="mb-2 text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: {entry.value}
          {entry.dataKey.includes("Duration") ? "m" : ""}
        </p>
      ))}
    </div>
  );
};

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-2xl border border-zinc-900 bg-zinc-950/70"
          />
        ))}
      </div>
      <div className="h-[420px] animate-pulse rounded-2xl border border-zinc-900 bg-zinc-950/70" />
    </div>
  );
}

function formatLastSyncLabel(analytics: DeviceMovementAnalytics | null) {
  if (!analytics?.lastComputedAt) {
    return "Waiting for canonical history";
  }

  const computedAt = new Date(analytics.lastComputedAt);

  return `Canonical as of ${computedAt.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function AnalyticsPage() {
  const {
    snapshot,
    setup,
    getDeviceAnalytics,
    refreshDeviceAnalytics,
    deleteDeviceAnalyticsHistory,
  } = useDesktopRuntime();
  const nodes = useMemo(
    () => (snapshot ? buildBluetoothNodes(snapshot, setup?.approvedNodes ?? []) : []),
    [setup?.approvedNodes, snapshot],
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [range, setRange] = useState<MovementAnalyticsRange>("24h");
  const [analyticsResult, setAnalyticsResult] = useState<DeviceMovementAnalyticsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedDeviceId && nodes.length > 0) {
      setSelectedDeviceId(nodes[0]?.id ?? null);
      return;
    }

    if (selectedDeviceId && nodes.some((node) => node.id === selectedDeviceId)) {
      return;
    }

    setSelectedDeviceId(nodes[0]?.id ?? null);
  }, [nodes, selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId) {
      setAnalyticsResult(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function loadAnalytics() {
      const deviceId = selectedDeviceId;

      if (!deviceId) {
        return;
      }

      setSyncError(null);
      setLoading(true);

      try {
        const cachedResult = await getDeviceAnalytics(deviceId, range);

        if (cancelled) {
          return;
        }

        setAnalyticsResult(cachedResult);

        if (!cachedResult.fromCache) {
          setLoading(false);
          return;
        }

        setLoading(false);
        setSyncing(true);

        const refreshedResult = await refreshDeviceAnalytics(deviceId, range);

        if (cancelled) {
          return;
        }

        setAnalyticsResult(refreshedResult);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setSyncError(error instanceof Error ? error.message : "Failed to load analytics.");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSyncing(false);
        }
      }
    }

    void loadAnalytics();

    return () => {
      cancelled = true;
    };
  }, [getDeviceAnalytics, refreshDeviceAnalytics, range, selectedDeviceId]);

  const canonicalAnalytics = analyticsResult?.analytics ?? null;
  const liveAnalytics = useMemo(
    () =>
      buildLiveMovementAnalytics({
        snapshot,
        deviceId: selectedDeviceId,
        range,
        provisionalStartAt: canonicalAnalytics?.lastCanonicalEventAt
          ? new Date(canonicalAnalytics.lastCanonicalEventAt)
          : null,
      }),
    [canonicalAnalytics?.lastCanonicalEventAt, range, selectedDeviceId, snapshot],
  );
  const chartPoints = useMemo(
    () => combineMovementAnalytics(canonicalAnalytics, liveAnalytics),
    [canonicalAnalytics, liveAnalytics],
  );
  const totals = useMemo(() => summarizeMovementChart(chartPoints), [chartPoints]);
  const selectedNode = nodes.find((node) => node.id === selectedDeviceId) ?? null;
  const showProvisionalOnly =
    !canonicalAnalytics?.hasCanonicalHistory && liveAnalytics !== null;
  const showSkeleton = loading && !showProvisionalOnly;

  async function handleRefresh() {
    if (!selectedDeviceId) {
      return;
    }

    setSyncing(true);
    setSyncError(null);

    try {
      const refreshedResult = await refreshDeviceAnalytics(selectedDeviceId, range);
      setAnalyticsResult(refreshedResult);
      toast.success("Canonical movement history refreshed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh analytics.";
      setSyncError(message);
      toast.error(message);
    } finally {
      setSyncing(false);
    }
  }

  async function handleDeleteHistory() {
    if (!selectedDeviceId) {
      return;
    }

    const confirmed = window.confirm(
      "Delete this device's analytics history? This removes canonical movement history and the local analytics cache.",
    );

    if (!confirmed) {
      return;
    }

    try {
      await deleteDeviceAnalyticsHistory(selectedDeviceId);
      setAnalyticsResult({
        analytics: null,
        fromCache: false,
      });
      toast.success("Analytics history deleted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete history.");
    }
  }

  return (
    <div className="flex size-full flex-col bg-black">
      <PageHeader
        title="Analytics"
        description="Canonical movement history with a live provisional tail."
        icon={TrendingUp}
        backHref="/"
        backLabel="Back to Dashboard"
        rightSlot={(
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            {syncing ? <div className="size-2 rounded-full bg-amber-400 animate-pulse" /> : <div className="size-2 rounded-full bg-emerald-400" />}
            {syncing ? "Syncing history" : formatLastSyncLabel(canonicalAnalytics)}
          </div>
        )}
      />

      <Toaster
        richColors
        position="top-right"
        toastOptions={{
          style: {
            background: "#09090b",
            color: "#f4f4f5",
            border: "1px solid #27272a",
          },
        }}
      />

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-[1680px] space-y-6">
          <div className="flex flex-col gap-3 rounded-2xl border border-zinc-900 bg-zinc-950/70 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                value={selectedDeviceId ?? ""}
                onChange={(event) => setSelectedDeviceId(event.target.value || null)}
                className="rounded-xl border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-blue-500"
              >
                {nodes.length === 0 ? <option value="">No devices</option> : null}
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>

              <select
                value={range}
                onChange={(event) => setRange(event.target.value as MovementAnalyticsRange)}
                className="rounded-xl border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-blue-500"
              >
                {RANGE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {RANGE_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                title="Refresh canonical analytics history"
                onClick={() => void handleRefresh()}
                disabled={!selectedDeviceId || syncing}
                className="border-zinc-800 bg-black text-zinc-200 hover:bg-zinc-900"
              >
                <RefreshCcw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Delete analytics history for this device"
                onClick={() => void handleDeleteHistory()}
                disabled={!selectedDeviceId}
                className="border-red-950 bg-black text-red-300 hover:bg-red-950/30 hover:text-red-200"
              >
                <Trash2 className="size-4" />
                Delete History
              </Button>
            </div>
          </div>

          {syncError ? (
            <div className="rounded-2xl border border-amber-900/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
              Analytics sync warning: {syncError}
            </div>
          ) : null}

          {canonicalAnalytics?.compactionNotice ? (
            <div className="rounded-2xl border border-orange-900/60 bg-orange-950/30 px-4 py-3 text-sm text-orange-200">
              {canonicalAnalytics.compactionNotice}
            </div>
          ) : null}

          {showSkeleton ? (
            <LoadingSkeleton />
          ) : selectedNode ? (
            <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
                <Card className="border-zinc-900 bg-zinc-950/70">
                  <CardHeader className="gap-3">
                    <CardDescription className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                      Device
                    </CardDescription>
                    <CardTitle className="text-2xl text-zinc-100">{selectedNode.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-sm text-zinc-400">
                    {showProvisionalOnly ? "Live provisional history" : RANGE_LABELS[range]}
                  </CardContent>
                </Card>

                <Card className="border-zinc-900 bg-zinc-950/70">
                  <CardHeader className="gap-3">
                    <CardDescription className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                      Movement Count
                    </CardDescription>
                    <CardTitle className="text-3xl text-zinc-100">{totals.movementCount}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-sm text-zinc-400">
                    Movement spans started in range
                  </CardContent>
                </Card>

                <Card className="border-zinc-900 bg-zinc-950/70">
                  <CardHeader className="gap-3">
                    <CardDescription className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                      Active Duration
                    </CardDescription>
                    <CardTitle className="text-3xl text-zinc-100">
                      {formatDurationLabel(totals.movementDurationMinutes)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-sm text-zinc-400">
                    Total moving time in visible buckets
                  </CardContent>
                </Card>

                <Card className="border-zinc-900 bg-zinc-950/70">
                  <CardHeader className="gap-3">
                    <CardDescription className="text-xs uppercase tracking-[0.18em] text-zinc-500">
                      History Status
                    </CardDescription>
                    <CardTitle className="flex items-center gap-2 text-zinc-100">
                      {showProvisionalOnly ? (
                        <>
                          <TimerReset className="size-5 text-amber-300" />
                          Building history
                        </>
                      ) : syncing ? (
                        <>
                          <RefreshCcw className="size-5 animate-spin text-amber-300" />
                          Syncing
                        </>
                      ) : (
                        <>
                          <Clock3 className="size-5 text-emerald-300" />
                          Canonical
                        </>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-sm text-zinc-400">
                    {canonicalAnalytics?.hasOlderHistory
                      ? "Additional older history exists beyond the current dropdown."
                      : "Visible range is fully represented here."}
                  </CardContent>
                </Card>
              </div>

              <Card className="border-zinc-900 bg-zinc-950/70">
                <CardHeader className="gap-2">
                  <CardTitle className="flex items-center gap-2 text-zinc-100">
                    <Activity className="size-5 text-cyan-300" />
                    Movement Duration and Count
                  </CardTitle>
                  <CardDescription className="text-zinc-500">
                    Canonical movement history with a live provisional overlay for the current tail.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {chartPoints.length > 0 ? (
                    <ResponsiveContainer width="100%" height={360}>
                      <ComposedChart data={chartPoints}>
                        <CartesianGrid stroke="#18181b" strokeDasharray="4 4" />
                        <XAxis
                          dataKey="label"
                          stroke="#52525b"
                          tick={{ fill: "#71717a", fontSize: 10 }}
                          minTickGap={14}
                        />
                        <YAxis
                          yAxisId="duration"
                          stroke="#52525b"
                          tick={{ fill: "#71717a", fontSize: 10 }}
                          width={48}
                        />
                        <YAxis
                          yAxisId="count"
                          orientation="right"
                          stroke="#52525b"
                          tick={{ fill: "#71717a", fontSize: 10 }}
                          width={32}
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar
                          yAxisId="duration"
                          dataKey="canonicalMovementDurationMinutes"
                          name="Canonical Duration"
                          fill="#0ea5e9"
                          radius={[6, 6, 0, 0]}
                        />
                        <Bar
                          yAxisId="duration"
                          dataKey="provisionalMovementDurationMinutes"
                          name="Live Duration"
                          fill="#f59e0b"
                          radius={[6, 6, 0, 0]}
                        />
                        <Line
                          yAxisId="count"
                          type="monotone"
                          dataKey="movementCount"
                          name="Movement Count"
                          stroke="#f4f4f5"
                          strokeWidth={2}
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-[360px] items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-500">
                      No movement history is available for this range yet.
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card className="border-zinc-900 bg-zinc-950/70">
                  <CardHeader className="gap-2">
                    <CardTitle className="text-zinc-100">Live Tail</CardTitle>
                    <CardDescription>
                      {showProvisionalOnly
                        ? "Showing provisional movement because canonical history has not been built yet."
                        : "Live provisional movement is merged invisibly on top of cached canonical history."}
                    </CardDescription>
                  </CardHeader>
                </Card>

                <Card className="border-zinc-900 bg-zinc-950/70">
                  <CardHeader className="gap-2">
                    <CardTitle className="text-zinc-100">Storage Policy</CardTitle>
                    <CardDescription>
                      Movement history is retained over low-priority runtime detail.
                    </CardDescription>
                  </CardHeader>
                </Card>

                <Card className="border-zinc-900 bg-zinc-950/70">
                  <CardHeader className="gap-2">
                    <CardTitle className="flex items-center gap-2 text-zinc-100">
                      <ShieldAlert className="size-5 text-zinc-300" />
                      Analytics Note
                    </CardTitle>
                    <CardDescription>
                      Times are rendered in this gateway's local timezone.
                    </CardDescription>
                  </CardHeader>
                </Card>
              </div>
            </>
          ) : (
            <div className="flex h-[320px] items-center justify-center rounded-2xl border border-dashed border-zinc-800 text-sm text-zinc-500">
              Pair a device to start building analytics history.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
