import { Bluetooth, Plus, Search, Signal } from "lucide-react";

import type { SetupDevice } from "../../selectors/types";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { SignalStrengthMeter } from "../SignalStrengthMeter";

type DiscoveryPanelProps = {
  devices: SetupDevice[];
  isScanning: boolean;
  pairingCandidateId: string | null;
  pendingPairIds: Set<string>;
  onScan: () => void;
  onPairDevice: (deviceId: string) => void;
};

export function DiscoveryPanel({
  devices,
  isScanning,
  pairingCandidateId,
  pendingPairIds,
  onScan,
  onPairDevice,
}: DiscoveryPanelProps) {
  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 mb-1">Bluetooth Discovery</h2>
          <p className="text-sm text-zinc-500">Scan for nearby motion tracking sensors</p>
        </div>
        <Button
          onClick={onScan}
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

      {isScanning ? (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <div className="flex items-center gap-2 text-sm text-blue-400">
            <Signal className="size-4 animate-pulse" />
            {pairingCandidateId
              ? "Connecting to the selected device..."
              : "Searching for Bluetooth devices..."}
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {devices.length === 0 && !isScanning ? (
          <div className="text-center py-8 text-zinc-600">
            <Bluetooth className="size-12 mx-auto mb-3 text-zinc-700" />
            <p className="text-sm">No devices found. Click "Start Scan" to begin.</p>
          </div>
        ) : null}

        {devices.map((device) => {
          const isPairing =
            pendingPairIds.has(device.id) || pairingCandidateId === device.id;

          return (
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
                  <div className="text-xs text-zinc-500 font-mono">
                    {device.macAddress ?? "--"}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <SignalStrengthMeter value={device.signalStrength} />
                <Button
                  onClick={() => onPairDevice(device.id)}
                  size="sm"
                  disabled={isPairing}
                  className="bg-blue-500 hover:bg-blue-600 text-white"
                >
                  <Plus className="size-4 mr-1" />
                  {isPairing ? "Pairing..." : "Pair"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
