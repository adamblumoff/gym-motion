import { useEffect, useState } from 'react';
import { Activity, Battery, BatteryLow, BatteryWarning, Bluetooth, Trash2 } from 'lucide-react';

import type { BluetoothNodeData } from '../data';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ScrollArea } from './ui/scroll-area';

interface BluetoothNodeProps {
  node: BluetoothNodeData;
  onClick?: () => void;
  onForget?: (nodeId: string) => void;
  onKeepDevice?: (nodeId: string) => void;
}

function connectionBadge(node: BluetoothNodeData) {
  switch (node.connectionState) {
    case 'connected':
      return {
        label: 'Connected',
        className: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      };
    case 'connecting':
    case 'reconnecting':
      return {
        label: 'Reconnecting',
        className: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      };
    default:
      return {
        label: 'Disconnected',
        className: 'bg-red-500/10 text-red-400 border-red-500/20',
      };
  }
}

export function BluetoothNode({ node, onClick, onForget, onKeepDevice }: BluetoothNodeProps) {
  const [pulseKey, setPulseKey] = useState(0);
  const [confirmForget, setConfirmForget] = useState(false);
  const statusBadge = connectionBadge(node);
  const showReconnectPrompt =
    node.connectionState === 'disconnected' &&
    node.reconnectAwaitingDecision;

  useEffect(() => {
    if (node.isMoving) {
      setPulseKey((prev) => prev + 1);
    }
  }, [node.isMoving]);

  const BatteryIcon =
    node.batteryLevel === null
      ? Battery
      : node.batteryLevel > 50
        ? Battery
        : node.batteryLevel > 20
          ? BatteryWarning
          : BatteryLow;
  const batteryColor =
    node.batteryLevel === null
      ? 'text-zinc-600'
      : node.batteryLevel > 50
        ? 'text-blue-400'
        : node.batteryLevel > 20
          ? 'text-amber-400'
          : 'text-red-400';

  return (
    <Card
      className="bg-zinc-900 border-zinc-800 overflow-hidden cursor-pointer hover:border-zinc-700 transition-all hover:shadow-lg hover:shadow-blue-500/5"
      onClick={onClick}
    >
      <div className="p-4 border-b border-zinc-800">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className={`relative p-2 rounded-lg ${node.isMoving ? 'bg-blue-500/10' : 'bg-zinc-800'}`}>
              <Bluetooth className={`size-5 ${node.isMoving ? 'text-blue-400' : 'text-zinc-500'}`} />
              {node.isMoving && (
                <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-blue-400 animate-ping" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-medium text-zinc-100 truncate">{node.name}</h3>
                {node.isMoving && (
                  <div key={pulseKey} className="flex items-center gap-1.5 animate-pulse">
                    <Activity className="size-3.5 text-blue-400" />
                    <span className="text-xs text-blue-400 font-medium">MOVING</span>
                  </div>
                )}
              </div>
              <div className="text-xs text-zinc-500 font-mono">{node.macAddress ?? 'Unknown address'}</div>
            </div>
          </div>
            <div className="flex flex-col items-end gap-2">
            <Badge
              variant={node.isConnected ? 'default' : 'secondary'}
              className={`text-xs ${statusBadge.className}`}
            >
              {statusBadge.label}
            </Badge>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4].map((bar) => (
                    <div
                      key={bar}
                      className={`w-0.5 rounded-full transition-colors ${
                        node.signalStrength !== null && bar <= Math.ceil(node.signalStrength / 25)
                          ? 'bg-blue-400'
                          : 'bg-zinc-700'
                      }`}
                      style={{ height: `${bar * 3 + 4}px` }}
                    />
                  ))}
                </div>
                <span className="text-xs text-zinc-500 font-mono">
                  {node.signalStrength === null ? '--' : `${node.signalStrength}%`}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <BatteryIcon className={`size-3.5 ${node.isConnected ? batteryColor : 'text-zinc-600'}`} />
                <span className="text-xs text-zinc-500 font-mono">
                  {node.isConnected && node.batteryLevel !== null ? `${node.batteryLevel}%` : '--'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 pt-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Activity Log</span>
          <span className="text-xs text-zinc-600">{node.logs.length} events</span>
        </div>
        <ScrollArea className="h-24">
          <div className="space-y-2 pr-4">
            {node.logs.length === 0 ? (
              <div className="text-xs text-zinc-600 text-center py-4">No activity logged</div>
            ) : (
              node.logs.map((log) => (
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
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {showReconnectPrompt && (
        <div
          className="mx-4 mb-3 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="text-xs font-medium text-amber-300">Do you want to forget this device?</div>
          <div className="mt-1 text-[11px] leading-4 text-zinc-400">
            Auto-reconnect paused after {node.reconnectAttemptLimit} scan bursts for this paired sensor. Keep it to resume reconnecting, or forget it to stop trying.
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              onClick={() => onKeepDevice?.(node.id)}
            >
              Keep Device
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onForget?.(node.id)}
            >
              Forget Device
            </Button>
          </div>
        </div>
      )}

      <div className="px-4 pb-4" onClick={(event) => event.stopPropagation()}>
        {confirmForget ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-400">Remove this sensor?</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400 hover:text-red-300 hover:bg-red-500/10 h-7 text-xs px-2"
              onClick={() => onForget?.(node.id)}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-zinc-500 hover:text-zinc-300 h-7 text-xs px-2"
              onClick={() => setConfirmForget(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-zinc-600 hover:text-red-400 hover:bg-red-500/10 h-7 text-xs px-2 -ml-2"
            onClick={() => setConfirmForget(true)}
          >
            <Trash2 className="size-3 mr-1.5" />
            Forget Device
          </Button>
        )}
      </div>
    </Card>
  );
}
