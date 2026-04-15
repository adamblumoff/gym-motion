import type { ReactNode } from 'react';
import { Bluetooth, Wifi } from 'lucide-react';

import type { BluetoothNodeData } from '../selectors/types';
import { canonicalNodeStatusLabel, isBlockingSensorIssue } from '../selectors/node-status';
import {
  formatSensorIssue,
  formatTelemetryLabel,
  statusIconClassName,
  statusIconTextClassName,
  statusToneClassName,
} from './node-display';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { cn } from './ui/utils';

interface NodeDetailModalProps {
  node: BluetoothNodeData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NodeDetailModal({ node, open, onOpenChange }: NodeDetailModalProps) {
  if (!node) return null;

  const hasBlockingSensorIssue = isBlockingSensorIssue(node.sensorIssue);
  const statusLabel = canonicalNodeStatusLabel(node.canonicalStatus);
  const deltaLabel = hasBlockingSensorIssue || node.lastDelta === null ? '--' : String(node.lastDelta);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100 max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className={cn('p-3 rounded-xl bg-zinc-800', statusIconClassName(node.canonicalStatus))}>
              <Bluetooth className={cn('size-6', statusIconTextClassName(node.canonicalStatus))} />
            </div>
            <div>
              <DialogTitle className="text-zinc-100">{node.name}</DialogTitle>
              <DialogDescription className="text-zinc-500 font-mono text-xs mt-1">
                {node.macAddress ?? 'Unknown address'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-4">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <DetailField
              label="Status"
              value={statusLabel}
              toneClassName={statusToneClassName(node.canonicalStatus)}
            />
            <DetailField label="Delta" value={deltaLabel} />
            <DetailField
              label="Signal"
              value={node.signalStrength === null ? '--' : `${node.signalStrength}%`}
              icon={<Wifi className="size-3.5 text-zinc-500" />}
            />
            <DetailField label="Telemetry" value={formatTelemetryLabel(node.lastTelemetryAt)} />
          </div>
          {node.sensorIssue && hasBlockingSensorIssue ? (
            <div className="mt-3 text-xs text-amber-300 text-pretty">
              Fault: {formatSensorIssue(node.sensorIssue)}
            </div>
          ) : node.sensorIssue === 'sensor_no_data' ? (
            <div className="mt-3 text-xs text-zinc-400 text-pretty">
              Sample status: waiting for a fresh reading from the board.
            </div>
          ) : node.connectionState !== 'connected' && node.lastDisconnectReason ? (
            <div className="mt-3 text-xs text-zinc-400 text-pretty">
              Disconnect reason: {node.lastDisconnectReason}
            </div>
          ) : null}
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
              ))}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailField({
  label,
  value,
  toneClassName,
  icon,
}: {
  label: string;
  value: string;
  toneClassName?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-zinc-800/50 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-zinc-400">
        {icon}
        {label}
      </div>
      <div className={cn('text-sm text-zinc-100 tabular-nums', toneClassName)}>{value}</div>
    </div>
  );
}
