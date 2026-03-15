import { Activity, Battery, Bluetooth, Wifi } from 'lucide-react';

import type { BluetoothNodeData } from '../data';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';

interface NodeDetailModalProps {
  node: BluetoothNodeData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NodeDetailModal({ node, open, onOpenChange }: NodeDetailModalProps) {
  if (!node) return null;

  const batteryColor =
    node.batteryLevel === null
      ? 'text-zinc-600'
      : node.batteryLevel > 60
        ? 'text-blue-400'
        : node.batteryLevel > 25
          ? 'text-amber-400'
          : 'text-red-400';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100 max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={`p-3 rounded-xl ${node.isMoving ? 'bg-blue-500/10' : 'bg-zinc-800'}`}>
              <Bluetooth className={`size-6 ${node.isMoving ? 'text-blue-400' : 'text-zinc-500'}`} />
            </div>
            <div>
              <DialogTitle className="text-zinc-100">{node.name}</DialogTitle>
              <DialogDescription className="text-zinc-500 font-mono text-xs mt-1">
                {node.macAddress ?? 'Unknown address'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-4 gap-3 mt-2">
          <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
            <Wifi className={`size-4 mx-auto mb-1.5 ${node.isConnected ? 'text-blue-400' : 'text-zinc-600'}`} />
            <div className="text-xs text-zinc-400">Signal</div>
            <div className="text-sm text-zinc-100 font-mono">
              {node.signalStrength === null ? '--' : `${node.signalStrength}%`}
            </div>
          </div>
          <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
            <Activity className={`size-4 mx-auto mb-1.5 ${node.isMoving ? 'text-blue-400' : 'text-zinc-600'}`} />
            <div className="text-xs text-zinc-400">Motion</div>
            <div className="text-sm text-zinc-100">{node.isMoving ? 'Active' : 'Still'}</div>
          </div>
          <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
            <Battery className={`size-4 mx-auto mb-1.5 ${batteryColor}`} />
            <div className="text-xs text-zinc-400">Battery</div>
            <div className="text-sm text-zinc-100 font-mono">
              {node.batteryLevel === null ? '--' : `${node.batteryLevel}%`}
            </div>
          </div>
          <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
            <Badge
              className={`text-xs mx-auto ${
                node.isConnected
                  ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`}
            >
              {node.isConnected ? 'Online' : 'Offline'}
            </Badge>
            <div className="text-xs text-zinc-400 mt-1.5">Status</div>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-zinc-400 uppercase tracking-wider">Activity Log</span>
            <span className="text-xs text-zinc-600">{node.logs.length} events</span>
          </div>
          <ScrollArea className="h-48 bg-zinc-950 rounded-lg p-3">
            <div className="space-y-2">
              {node.logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-2 text-xs pb-2 border-b border-zinc-800/50 last:border-0"
                >
                  <span className="text-zinc-600 font-mono shrink-0">
                    {log.timestamp.toLocaleTimeString('en-US', {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span className={`${log.isMoving ? 'text-blue-400' : 'text-zinc-500'} flex-1`}>
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
