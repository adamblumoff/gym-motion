import { useMemo } from 'react';
import { Link } from 'react-router';
import { Activity, ArrowLeft, Bluetooth, Clock, TrendingUp, Wifi } from 'lucide-react';
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
  buildBatteryData,
  buildBluetoothNodes,
  buildMovementData,
  buildSignalHistory,
  buildUptimeData,
  calculateAverageSignal,
} from '../data';
import { useDesktopRuntime } from '../runtime-context';
import { Button } from './ui/button';
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
    () => (snapshot ? buildBluetoothNodes(snapshot) : []),
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
  const uptimeData = useMemo(() => buildUptimeData(nodes), [nodes]);
  const batteryData = useMemo(() => buildBatteryData(nodes), [nodes]);
  const statusData = useMemo(
    () => [
      { name: 'Connected', value: nodes.filter((node) => node.isConnected).length, fill: '#3b82f6' },
      { name: 'Offline', value: nodes.filter((node) => !node.isConnected).length, fill: '#3f3f46' },
    ],
    [nodes],
  );

  const totalMovements = movementData.reduce((sum, item) => sum + item.movements, 0);
  const latestSignal = signalHistory[signalHistory.length - 1] ?? null;
  const avgSignal = calculateAverageSignal(latestSignal);
  const avgUptime =
    uptimeData.filter((item) => item.uptime > 0).reduce((sum, item) => sum + item.uptime, 0) /
    Math.max(1, uptimeData.filter((item) => item.uptime > 0).length);

  return (
    <div className="size-full flex flex-col bg-black">
      <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/">
              <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-zinc-100">
                <ArrowLeft className="size-4 mr-2" />
                Back to Dashboard
              </Button>
            </Link>
            <div className="w-px h-8 bg-zinc-800" />
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-blue-500/10 rounded-lg">
                <TrendingUp className="size-6 text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-zinc-100">Analytics</h1>
                <p className="text-sm text-zinc-500">Network performance & motion trends</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <div className="size-2 rounded-full bg-blue-400 animate-pulse" />
            Live data
          </div>
        </div>
      </div>

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
                <Clock className="size-5 text-blue-400" />
                <span className="text-xs text-zinc-600 uppercase tracking-wider">Avg Uptime</span>
              </div>
              <div className="text-3xl text-zinc-100 font-mono">{avgUptime.toFixed(1)}%</div>
              <div className="text-xs text-blue-400 mt-1">Current connection state</div>
            </Card>
          </div>

          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-sm font-medium text-zinc-100">Signal Strength Over Time</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Recent recorded motion samples</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={signalHistory}>
                <defs>
                  <linearGradient id="gradA" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradB" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="time" stroke="#3f3f46" tick={{ fill: '#52525b', fontSize: 10 }} interval={1} />
                <YAxis domain={[0, 100]} stroke="#3f3f46" tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={(value) => `${value}%`} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="sensorA" name="Sensor A" stroke="#3b82f6" fill="url(#gradA)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="sensorB" name="Sensor B" stroke="#06b6d4" fill="url(#gradB)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="sensorC" name="Sensor C" stroke="#8b5cf6" fill="transparent" strokeWidth={1.5} />
                <Area type="monotone" dataKey="sensorD" name="Sensor D" stroke="#3b82f680" fill="transparent" strokeWidth={1} />
                <Area type="monotone" dataKey="sensorE" name="Sensor E" stroke="#06b6d480" fill="transparent" strokeWidth={1} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Movement Frequency</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Detected motion events by hour</p>
              </div>
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
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Battery Levels</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Current charge across all sensors</p>
              </div>
              <div className="space-y-4">
                {batteryData.map((sensor) => (
                  <div key={sensor.name} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-400 w-20 shrink-0">{sensor.name}</span>
                    <div className="flex-1 h-3 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${sensor.level ?? 0}%`,
                          backgroundColor:
                            sensor.level === null
                              ? '#27272a'
                              : sensor.level > 60
                                ? '#3b82f6'
                                : sensor.level > 25
                                  ? '#f59e0b'
                                  : sensor.level > 0
                                    ? '#ef4444'
                                    : '#27272a',
                        }}
                      />
                    </div>
                    <span className="text-xs text-zinc-500 font-mono w-10 text-right">
                      {sensor.level !== null && sensor.level > 0 ? `${sensor.level}%` : 'N/A'}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="bg-zinc-900 border-zinc-800 p-6 lg:col-span-2">
              <div className="mb-6">
                <h2 className="text-sm font-medium text-zinc-100">Node Uptime (Current Snapshot)</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Connection reliability per sensor</p>
              </div>
              <div className="space-y-3">
                {uptimeData.map((sensor) => (
                  <div key={sensor.name} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-400 w-20 shrink-0">{sensor.name}</span>
                    <div className="flex-1 h-6 bg-zinc-800 rounded overflow-hidden relative">
                      <div
                        className="h-full rounded transition-all duration-700"
                        style={{
                          width: `${sensor.uptime}%`,
                          backgroundColor: sensor.fill,
                          opacity: sensor.uptime > 0 ? 0.6 : 0.1,
                        }}
                      />
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-300 font-mono">
                        {sensor.uptime > 0 ? `${sensor.uptime}%` : 'Offline'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

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
