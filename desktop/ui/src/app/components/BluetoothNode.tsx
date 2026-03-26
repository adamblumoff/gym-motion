import { useEffect, useState } from 'react';
import { Activity, Bluetooth, Trash2 } from 'lucide-react';

import type { BluetoothNodeData } from '../selectors/types';
import { DeviceConnectionBadge } from './DeviceConnectionBadge';
import { SignalStrengthMeter } from './SignalStrengthMeter';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ScrollArea } from './ui/scroll-area';

interface BluetoothNodeProps {
  node: BluetoothNodeData;
  onClick?: () => void;
  onRequestForget?: (nodeId: string) => void;
  onKeepDevice?: (nodeId: string) => void;
  forgetPending?: boolean;
  keepPending?: boolean;
}

export function BluetoothNode({
  node,
  onClick,
  onRequestForget,
  onKeepDevice,
  forgetPending = false,
  keepPending = false,
}: BluetoothNodeProps) {
  const [pulseKey, setPulseKey] = useState(0);
  const showReconnectPrompt =
    node.connectionState === 'disconnected' &&
    node.reconnectAwaitingDecision;

  useEffect(() => {
    if (node.isMoving) {
      setPulseKey((prev) => prev + 1);
    }
  }, [node.isMoving]);

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
            <DeviceConnectionBadge state={node.connectionState} className="text-xs" />
            <div className="flex items-center gap-3">
              <SignalStrengthMeter value={node.signalStrength} />
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
                  className="flex items-start gap-2 text-xs pb-2 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 rounded px-1 -mx-1 transition-colors"
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
              type="button"
              disabled={keepPending || forgetPending}
              className="h-6 px-2 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void onKeepDevice?.(node.id);
              }}
            >
              {keepPending ? 'Keeping...' : 'Keep Device'}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              type="button"
              disabled={forgetPending || keepPending}
              className="h-6 px-2 text-[11px]"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void onRequestForget?.(node.id);
              }}
            >
              {forgetPending ? 'Forgetting...' : 'Forget Device'}
            </Button>
          </div>
        </div>
      )}

      <div className="px-4 pb-4" onClick={(event) => event.stopPropagation()}>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={forgetPending || keepPending}
          className="text-zinc-600 hover:text-red-400 hover:bg-red-500/10 h-7 text-xs px-2 -ml-2"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void onRequestForget?.(node.id);
          }}
        >
          <Trash2 className="size-3 mr-1.5" />
          {forgetPending ? 'Forgetting...' : 'Forget Device'}
        </Button>
      </div>
    </Card>
  );
}
