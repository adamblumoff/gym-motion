import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  ArrowLeft,
  Bluetooth,
  Check,
  Plus,
  RefreshCw,
  Search,
  Signal,
} from 'lucide-react';
import { toast } from 'sonner';

import { isOperatorVisibleScan } from '@core/gateway-scan';
import { buildApprovedNodeRules } from '../../lib/setup-rules';
import { buildPairedDevices, buildSetupVisibleDevices } from '../data';
import { useDesktopRuntime } from '../runtime-context';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ConfirmationDialog } from './ConfirmationDialog';

type RemovalTarget = {
  id: string;
  name: string;
};

function addToSet(current: Set<string>, value: string) {
  const next = new Set(current);
  next.add(value);
  return next;
}

function removeFromSet(current: Set<string>, value: string) {
  const next = new Set(current);
  next.delete(value);
  return next;
}

export function SetupPage() {
  const { setup, snapshot, rescanAdapters, recoverApprovedNode, setAllowedNodes } = useDesktopRuntime();
  const discoveredDevices = setup
    ? buildSetupVisibleDevices(setup, setup.approvedNodes).filter((device) => !device.isPaired)
    : [];
  const pairedDevices = setup ? buildPairedDevices(setup, snapshot) : [];
  const isScanning = snapshot
    ? isOperatorVisibleScan(snapshot.gateway.scanState, snapshot.gateway.scanReason)
    : false;
  const [pendingPairIds, setPendingPairIds] = useState<Set<string>>(new Set());
  const [pendingRecoverIds, setPendingRecoverIds] = useState<Set<string>>(new Set());
  const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<RemovalTarget | null>(null);

  useEffect(() => {
    setPendingPairIds((current) => {
      const next = new Set(
        Array.from(current).filter((deviceId) => discoveredDevices.some((device) => device.id === deviceId)),
      );
      return next.size === current.size ? current : next;
    });
    setPendingRecoverIds((current) => {
      const next = new Set(
        Array.from(current).filter((deviceId) => pairedDevices.some((device) => device.id === deviceId)),
      );
      return next.size === current.size ? current : next;
    });
    setPendingRemoveIds((current) => {
      const next = new Set(
        Array.from(current).filter((deviceId) => pairedDevices.some((device) => device.id === deviceId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [discoveredDevices, pairedDevices]);

  useEffect(() => {
    if (!removeTarget) {
      return;
    }

    if (!pairedDevices.some((device) => device.id === removeTarget.id)) {
      setRemoveTarget(null);
    }
  }, [pairedDevices, removeTarget]);

  function pairedBadge(device: (typeof pairedDevices)[number]) {
    switch (device.connectionState) {
      case 'connected':
        return {
          label: 'Connected',
          className: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
          icon: Check,
        };
      case 'connecting':
      case 'reconnecting':
        return {
          label: 'Reconnecting',
          className: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
          icon: RefreshCw,
        };
      default:
        return {
          label: 'Disconnected',
          className: 'bg-red-500/10 text-red-400 border-red-500/20',
          icon: Bluetooth,
        };
    }
  }

  const handleScan = async () => {
    try {
      await rescanAdapters();
      toast.success('Scan started.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start scan.');
    }
  };

  const handlePairDevice = async (deviceId: string) => {
    if (!setup) {
      return;
    }

    setPendingPairIds((current) => addToSet(current, deviceId));
    const nextIds = new Set(setup.approvedNodes.map((node) => node.id));
    nextIds.add(deviceId);
    let pairedSaved = false;

    try {
      await setAllowedNodes(buildApprovedNodeRules(setup, nextIds));
      pairedSaved = true;
      await recoverApprovedNode(deviceId);
      setPendingPairIds((current) => removeFromSet(current, deviceId));
      toast.success('Device paired. Connecting...');
    } catch (error) {
      setPendingPairIds((current) => removeFromSet(current, deviceId));
      if (pairedSaved) {
        toast.error(
          error instanceof Error
            ? `Device paired, but failed to start connecting: ${error.message}`
            : 'Device paired, but failed to start connecting.',
        );
        return;
      }

      toast.error(error instanceof Error ? error.message : 'Failed to pair device.');
    }
  };

  const requestUnpairDevice = (deviceId: string) => {
    const device = pairedDevices.find((entry) => entry.id === deviceId);
    if (!device) {
      return;
    }

    setRemoveTarget({
      id: device.id,
      name: device.name,
    });
  };

  const confirmUnpairDevice = async () => {
    if (!setup || !removeTarget) {
      return;
    }

    const deviceId = removeTarget.id;
    setPendingRemoveIds((current) => addToSet(current, deviceId));
    const nextIds = new Set(
      setup.approvedNodes.map((node) => node.id).filter((id) => id !== deviceId),
    );

    try {
      await setAllowedNodes(buildApprovedNodeRules(setup, nextIds));
      setRemoveTarget(null);
      toast.success('Device removed.');
    } catch (error) {
      setPendingRemoveIds((current) => removeFromSet(current, deviceId));
      toast.error(error instanceof Error ? error.message : 'Failed to remove device.');
    }
  };

  const handleRecoverDevice = async (deviceId: string) => {
    setPendingRecoverIds((current) => addToSet(current, deviceId));

    try {
      await recoverApprovedNode(deviceId);
      setPendingRecoverIds((current) => removeFromSet(current, deviceId));
      toast.success('Recovery requested.');
    } catch (error) {
      setPendingRecoverIds((current) => removeFromSet(current, deviceId));
      toast.error(error instanceof Error ? error.message : 'Failed to recover device.');
    }
  };

  const removePending = removeTarget ? pendingRemoveIds.has(removeTarget.id) : false;

  return (
    <div className="size-full flex flex-col bg-black">
      <ConfirmationDialog
        open={removeTarget !== null}
        title="Forget this device?"
        description={`This removes ${removeTarget?.name ?? 'this sensor'} from approved devices and stops automatic reconnect attempts until you pair it again.`}
        confirmLabel="Forget Device"
        pending={removePending}
        onOpenChange={(open) => {
          if (!open && !removePending) {
            setRemoveTarget(null);
          }
        }}
        onConfirm={() => void confirmUnpairDevice()}
      />

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
                <Bluetooth className="size-6 text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-zinc-100">Sensor Setup</h1>
                <p className="text-sm text-zinc-500">Scan and configure Bluetooth devices</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100 mb-1">Bluetooth Discovery</h2>
                <p className="text-sm text-zinc-500">Scan for nearby motion tracking sensors</p>
              </div>
              <Button
                onClick={() => void handleScan()}
                disabled={isScanning}
                className="bg-blue-500 hover:bg-blue-600 text-white"
              >
                {isScanning ? (
                  <>
                    <div className="animate-spin size-4 border-2 border-white border-t-transparent rounded-full mr-2" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <Search className="size-4 mr-2" />
                    Start Scan
                  </>
                )}
              </Button>
            </div>

            {isScanning && (
              <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-blue-400">
                  <Signal className="size-4 animate-pulse" />
                  Searching for Bluetooth devices...
                </div>
              </div>
            )}

            <div className="space-y-3">
              {discoveredDevices.length === 0 && !isScanning && (
                <div className="text-center py-8 text-zinc-600">
                  <Bluetooth className="size-12 mx-auto mb-3 text-zinc-700" />
                  <p className="text-sm">No devices found. Click "Start Scan" to begin.</p>
                </div>
              )}

              {discoveredDevices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between p-4 bg-zinc-800/50 border border-zinc-800 rounded-lg hover:border-zinc-700 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-zinc-800 rounded-lg">
                      <Bluetooth className="size-5 text-zinc-400" />
                    </div>
                    <div>
                      <div className="font-medium text-zinc-100">{device.name}</div>
                      <div className="text-xs text-zinc-500 font-mono">{device.macAddress ?? '--'}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5">
                      <div className="flex gap-0.5">
                        {[1, 2, 3, 4].map((bar) => (
                          <div
                            key={bar}
                            className={`w-0.5 rounded-full ${
                              device.signalStrength !== null && bar <= Math.ceil(device.signalStrength / 25)
                                ? 'bg-blue-400'
                                : 'bg-zinc-700'
                            }`}
                            style={{ height: `${bar * 3 + 4}px` }}
                          />
                        ))}
                      </div>
                      <span className="text-xs text-zinc-500 font-mono">
                        {device.signalStrength === null ? '--' : `${device.signalStrength}%`}
                      </span>
                    </div>

                    <Button
                      onClick={() => void handlePairDevice(device.id)}
                      size="sm"
                      disabled={pendingPairIds.has(device.id)}
                      className="bg-blue-500 hover:bg-blue-600 text-white"
                    >
                      <Plus className="size-4 mr-1" />
                      {pendingPairIds.has(device.id) ? 'Pairing...' : 'Pair'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-zinc-100 mb-1">Paired Sensors</h2>
              <p className="text-sm text-zinc-500">{pairedDevices.length} devices configured</p>
            </div>

            <div className="space-y-3">
              {pairedDevices.length === 0 ? (
                <div className="text-center py-8 text-zinc-600">
                  <p className="text-sm">No sensors paired yet. Scan and pair devices to get started.</p>
                </div>
              ) : (
                pairedDevices.map((device) => {
                  const badge = pairedBadge(device);
                  const BadgeIcon = badge.icon;
                  const recovering = pendingRecoverIds.has(device.id);
                  const removing = pendingRemoveIds.has(device.id);

                  return (
                    <div
                      key={device.id}
                      className="flex items-center justify-between p-4 bg-blue-500/5 border border-blue-500/20 rounded-lg"
                    >
                      <div className="flex items-center gap-4">
                        <div className="p-2 bg-blue-500/10 rounded-lg">
                          <Bluetooth className="size-5 text-blue-400" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-zinc-100">{device.name}</span>
                            <Badge className={`${badge.className} text-xs`}>
                              <BadgeIcon
                                className={`size-3 mr-1 ${
                                  badge.label === 'Reconnecting' ? 'animate-spin' : ''
                                }`}
                              />
                              {badge.label}
                            </Badge>
                          </div>
                          <div className="text-xs text-zinc-500 font-mono">
                            {device.macAddress ?? '--'}
                          </div>
                          {device.lastDisconnectReason ? (
                            <div className="mt-1 max-w-md text-xs text-amber-400">
                              {device.lastDisconnectReason}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {device.connectionState !== 'connected' ? (
                          <Button
                            onClick={() => void handleRecoverDevice(device.id)}
                            size="sm"
                            variant="secondary"
                            disabled={recovering || removing}
                            className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
                          >
                            {recovering ? 'Recovering...' : 'Recover'}
                          </Button>
                        ) : null}
                        <Button
                          onClick={() => requestUnpairDevice(device.id)}
                          variant="ghost"
                          size="sm"
                          disabled={recovering || removing}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        >
                          {removing ? 'Forgetting...' : 'Remove'}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
