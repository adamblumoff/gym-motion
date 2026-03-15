import { Bluetooth, Settings, BarChart3, Command } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from './ui/button';

interface DashboardHeaderProps {
  totalNodes: number;
  activeNodes: number;
  movingNodes: number;
}

export function DashboardHeader({ totalNodes, activeNodes, movingNodes }: DashboardHeaderProps) {
  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-500/10 rounded-lg">
            <Bluetooth className="size-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Motion Tracking Dashboard</h1>
            <p className="text-sm text-zinc-500">Real-time accelerometer monitoring</p>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-2xl font-semibold text-zinc-100">{totalNodes}</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Total Nodes</div>
          </div>
          <div className="w-px h-12 bg-zinc-800" />
          <div className="text-right">
            <div className="text-2xl font-semibold text-blue-400">{activeNodes}</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Connected</div>
          </div>
          <div className="w-px h-12 bg-zinc-800" />
          <div className="text-right">
            <div className="text-2xl font-semibold text-cyan-400">{movingNodes}</div>
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Active Motion</div>
          </div>
          <div className="w-px h-12 bg-zinc-800" />
          <Link to="/analytics">
            <Button variant="ghost" className="text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
              <BarChart3 className="size-4 mr-2" />
              Analytics
            </Button>
          </Link>
          <div className="flex items-center gap-2 text-xs text-zinc-600 bg-zinc-800/50 rounded-lg px-3 py-2 border border-zinc-800">
            <Command className="size-3" />
            <span>K</span>
          </div>
          <Link to="/setup">
            <Button className="bg-blue-500 hover:bg-blue-600 text-white">
              <Settings className="size-4 mr-2" />
              Setup Sensors
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
