import { Bluetooth } from "lucide-react";

import type { SetupDevice } from "../../selectors/types";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { DeviceConnectionBadge } from "../DeviceConnectionBadge";

type PairedDevicesPanelProps = {
  devices: SetupDevice[];
  pendingRecoverIds: Set<string>;
  pendingRemoveIds: Set<string>;
  onRecoverDevice: (deviceId: string) => void;
  onRequestUnpairDevice: (deviceId: string) => void;
};

export function PairedDevicesPanel({
  devices,
  pendingRecoverIds,
  pendingRemoveIds,
  onRecoverDevice,
  onRequestUnpairDevice,
}: PairedDevicesPanelProps) {
  return (
    <Card className="bg-zinc-900 border-zinc-800 p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">Paired Sensors</h2>
        <p className="text-sm text-zinc-500">{devices.length} devices configured</p>
      </div>

      <div className="space-y-3">
        {devices.length === 0 ? (
          <div className="text-center py-8 text-zinc-600">
            <p className="text-sm">No sensors paired yet. Scan and pair devices to get started.</p>
          </div>
        ) : null}

        {devices.map((device) => {
          const recovering = pendingRecoverIds.has(device.id);
          const removing = pendingRemoveIds.has(device.id);

          return (
            <div
              key={device.id}
              className="flex items-center justify-between p-4 bg-blue-500/5 border border-blue-500/20 rounded-lg hover:border-blue-500/35 hover:bg-blue-500/8 transition-colors"
            >
              <div className="flex items-center gap-4">
                <div className="p-2 bg-blue-500/10 rounded-lg">
                  <Bluetooth className="size-5 text-blue-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-zinc-100">{device.name}</span>
                    <DeviceConnectionBadge state={device.connectionState} className="text-xs" />
                  </div>
                  <div className="text-xs text-zinc-500 font-mono">
                    {device.macAddress ?? "--"}
                  </div>
                  {device.lastDisconnectReason ? (
                    <div className="mt-1 max-w-md text-xs text-amber-400">
                      {device.lastDisconnectReason}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {device.connectionState !== "connected" ? (
                  <Button
                    onClick={() => onRecoverDevice(device.id)}
                    size="sm"
                    variant="secondary"
                    disabled={recovering || removing}
                    className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
                  >
                    {recovering ? "Recovering..." : "Recover"}
                  </Button>
                ) : null}
                <Button
                  onClick={() => onRequestUnpairDevice(device.id)}
                  variant="ghost"
                  size="sm"
                  disabled={recovering || removing}
                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                >
                  {removing ? "Forgetting..." : "Remove"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
