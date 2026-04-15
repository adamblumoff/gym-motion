import { Bluetooth, Trash2 } from 'lucide-react';

import type { BluetoothNodeData } from '../selectors/types';
import { canonicalNodeStatusLabel, isBlockingSensorIssue } from '../selectors/node-status';
import {
  formatSensorIssue,
  formatTelemetryLabel,
  statusIconClassName,
  statusIconTextClassName,
  statusToneClassName,
} from './node-display';
import { SignalStrengthMeter } from './SignalStrengthMeter';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { cn } from './ui/utils';

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
  const showReconnectPrompt =
    node.connectionState === 'disconnected' &&
    node.reconnectAwaitingDecision;
  const hasBlockingSensorIssue = isBlockingSensorIssue(node.sensorIssue);
  const lastTelemetryLabel = formatTelemetryLabel(node.lastTelemetryAt);
  const deltaLabel = hasBlockingSensorIssue || node.lastDelta === null ? '--' : String(node.lastDelta);
  const statusLabel = canonicalNodeStatusLabel(node.canonicalStatus);
  const statusClassName = statusToneClassName(node.canonicalStatus);
  const secondaryText = buildSecondaryText(node);

  return (
    <Card
      className="group bg-zinc-900 border-zinc-800 overflow-hidden cursor-pointer hover:border-zinc-700 transition-all hover:shadow-lg hover:shadow-blue-500/5"
      onClick={onClick}
    >
      <div className="p-4 border-b border-zinc-800">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div
              className={cn('p-2 rounded-lg bg-zinc-800', statusIconClassName(node.canonicalStatus))}
            >
              <Bluetooth className={cn('size-5', statusIconTextClassName(node.canonicalStatus))} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium text-zinc-100 truncate text-balance">{node.name}</h3>
              <div className="text-xs text-zinc-500 font-mono">{node.macAddress ?? 'Unknown address'}</div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                <span>
                  Status: <span className={statusClassName}>{statusLabel}</span>
                </span>
                <span>
                  Delta: <span className="text-zinc-300">{deltaLabel}</span>
                </span>
                <span>
                  Telemetry: <span className="text-zinc-300">{lastTelemetryLabel}</span>
                </span>
                {node.sensorIssue && hasBlockingSensorIssue ? (
                  <span>
                    Fault: <span className="text-amber-300">{formatSensorIssue(node.sensorIssue)}</span>
                  </span>
                ) : null}
              </div>
              {secondaryText ? (
                <div className="mt-2 text-xs text-zinc-400 text-pretty">{secondaryText}</div>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
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

function buildSecondaryText(node: BluetoothNodeData) {
  if (isBlockingSensorIssue(node.sensorIssue)) {
    return 'The sensor is connected, but the board is reporting a live sensor fault.';
  }

  if (node.sensorIssue === 'sensor_no_data') {
    return 'Waiting for a fresh sample from the sensor.';
  }

  if (node.connectionState === 'connecting' || node.connectionState === 'reconnecting') {
    return 'The gateway is trying to re-establish the Bluetooth connection.';
  }

  if (node.connectionState !== 'connected') {
    return node.lastDisconnectReason ?? 'This sensor is not currently reachable.';
  }

  if (node.canonicalStatus === 'moving') {
    return 'Live motion is being detected right now.';
  }

  return 'The sensor is connected and currently idle.';
}
