import { Link } from 'react-router';
import { ArrowLeft, Bluetooth, Check, Plus, Search, Signal } from 'lucide-react';

import { buildApprovedNodeRules } from '../../lib/setup-rules';
import { buildPairedDevices, buildSetupVisibleDevices } from '../data';
import { useDesktopRuntime } from '../runtime-context';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';

export function SetupPage() {
  const { setup, snapshot, rescanAdapters, setAllowedNodes } = useDesktopRuntime();
  const discoveredDevices = setup ? buildSetupVisibleDevices(setup, setup.approvedNodes) : [];
  const pairedDevices = setup ? buildPairedDevices(setup) : [];
  const isScanning = snapshot?.gateway.scanState === 'scanning';

  const handleScan = () => {
    void rescanAdapters();
  };

  const handlePairDevice = (deviceId: string) => {
    if (!setup) {
      return;
    }

    const nextIds = new Set(setup.approvedNodes.map((node) => node.id));
    nextIds.add(deviceId);
    void setAllowedNodes(buildApprovedNodeRules(setup, nextIds));
  };

  const handleUnpairDevice = (deviceId: string) => {
    if (!setup) {
      return;
    }

    const nextIds = new Set(
      setup.approvedNodes.map((node) => node.id).filter((id) => id !== deviceId),
    );
    void setAllowedNodes(buildApprovedNodeRules(setup, nextIds));
  };

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
                onClick={handleScan}
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
                      onClick={() => handlePairDevice(device.id)}
                      size="sm"
                      className="bg-blue-500 hover:bg-blue-600 text-white"
                    >
                      <Plus className="size-4 mr-1" />
                      Pair
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
                pairedDevices.map((device) => (
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
                          <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
                            <Check className="size-3 mr-1" />
                            Paired
                          </Badge>
                        </div>
                        <div className="text-xs text-zinc-500 font-mono">{device.macAddress ?? '--'}</div>
                      </div>
                    </div>

                    <Button
                      onClick={() => handleUnpairDevice(device.id)}
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      Remove
                    </Button>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
