import { useMemo } from 'react';
import { Activity, Bluetooth, TrendingUp, Wifi } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  buildMovementData,
  buildSignalHistory,
  calculateAverageSignal,
} from '../selectors/analytics';
import { buildBluetoothNodes as buildDashboardNodes } from '../selectors/dashboard';
import { useDesktopRuntime } from '../runtime-context';
import { PageHeader } from './PageHeader';
import { Card } from './ui/card';

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 shadow-xl">
        <p className="text-xs text-zinc-400 mb-1">{label}</p>
        {payload.map((entry: any, index: number) => (
          <p key={index} className="text-xs" style={{ color: entry.color }}>
            {entry.name}: {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}
            {entry.name === 'movements' ? ' events' : '%'}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export function AnalyticsPage() {
  const { snapshot } = useDesktopRuntime();
  const nodes = useMemo(
    () => (snapshot ? buildDashboardNodes(snapshot) : []),
    [snapshot],
  );
  const signalHistory = useMemo(
    () => buildSignalHistory(snapshot?.events ?? [], nodes),
    [nodes, snapshot?.events],
  );
  const movementData = useMemo(
    () => buildMovementData(snapshot?.events ?? []),
    [snapshot?.events],
  );
  const statusData = useMemo(
    () => [
      { name: 'Connected', value: nodes.filter((node) => node.isConnected).length, fill: '#3b82f6' },
      { name: 'Offline', value: nodes.filter((node) => !node.isConnected).length, fill: '#3f3f46' },
    ],
    [nodes],
  );

  const totalMovements = movementData.reduce((sum, item) => sum + item.movements, 0);
  const latestSignal = signalHistory.points[signalHistory.points.length - 1] ?? null;
  const avgSignal = calculateAverageSignal(latestSignal, signalHistory.series);
  const hasMotionHistory = movementData.length > 0;
  const hasSignalHistory =
    signalHistory.points.length > 0 && signalHistory.series.length > 0;

  return (
    <div className="size-full flex flex-col bg-black">
      <PageHeader
        title="Analytics"
        description="Network performance and motion trends"
        icon={TrendingUp}
        backHref="/"
        backLabel="Back to Dashboard"
        rightSlot={(
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <div className="size-2 rounded-full bg-blue-400 animate-pulse" />
            Live data
          </div>
        )}
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1800px] mx-auto space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <Bluetooth className="size-5 text-blue-400" />
                <span className="text-xs text-zinc-600 uppercase tracking-wider">Nodes</span>
              </div>
              <div className="text-3xl text-zinc-100 font-mono">{nodes.length}</div>
              <div className="text-xs text-blue-400 mt-1">{statusData[0]?.value ?? 0} connected</div>
            </Card>
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <Activity className="size-5 text-cyan-400" />
                <span className="text-xs text-zinc-600 uppercase tracking-wider">Movements</span>
              </div>
              <div className="text-3xl text-zinc-100 font-mono">{totalMovements}</div>
              <div className="text-xs text-cyan-400 mt-1">From recorded events</div>
            </Card>
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <Wifi className="size-5 text-violet-400" />
                <span className="text-xs text-zinc-600 uppercase tracking-wider">Avg Signal</span>
              </div>
              <div className="text-3xl text-zinc-100 font-mono">{avgSignal}%</div>
              <div className="text-xs text-violet-400 mt-1">Across current nodes</div>
            </Card>
            <Card className="bg-zinc-900 border-zinc-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <Bluetooth className="size-5 text-blue-400" />
                <span className="text-xs text-zinc-600 uppercase tracking-wider">Status</span>
              </div>
              <div className="text-3xl text-zinc-100 font-mono">{statusData[1]?.value ?? 0}</div>
              <div className="text-xs text-blue-400 mt-1">Currently offline</div>
            </Card>
          </div>

          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-sm font-medium text-zinc-100">Signal Strength Over Time</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Recent recorded motion samples</p>
              </div>
            </div>
            {hasSignalHistory ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={signalHistory.points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="time" stroke="#3f3f46" tick={{ fill: '#52525b', fontSize: 10 }} interval={1} />
                  <YAxis domain={[0, 100]} stroke="#3f3f46" tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={(value) => `${value}%`} />
                  <Tooltip content={<CustomTooltip />} />
                  {signalHistory.series.map((signalSeries) => (
                    <Area
                      key={signalSeries.id}
                      type="monotone"
                      dataKey={signalSeries.id}
                      name={signalSeries.name}
                      stroke={signalSeries.color}
                      fill={signalSeries.color}
                      fillOpacity={0.12}
                      strokeWidth={1.5}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-500">
                Motion history will appear here after the runtime records live events.
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-6">
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Movement Frequency</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Detected motion events by hour</p>
              </div>
              {hasMotionHistory ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={movementData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="hour" stroke="#3f3f46" tick={{ fill: '#52525b', fontSize: 10 }} interval={0} />
                    <YAxis stroke="#3f3f46" tick={{ fill: '#52525b', fontSize: 10 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="movements" radius={[3, 3, 0, 0]}>
                      {movementData.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={entry.movements > 10 ? '#3b82f6' : entry.movements > 3 ? '#3b82f680' : '#27272a'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-sm text-zinc-500">
                  Movement counts appear once the runtime has recorded motion events.
                </div>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6">
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-zinc-100">Connection Status</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Current network overview</p>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={75}
                    paddingAngle={4}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex justify-center gap-4 mt-2">
                {statusData.map((entry) => (
                  <div key={entry.name} className="flex items-center gap-1.5">
                    <div className="size-2 rounded-full" style={{ backgroundColor: entry.fill }} />
                    <span className="text-[10px] text-zinc-400">
                      {entry.name} ({entry.value})
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
