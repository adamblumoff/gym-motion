import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { buildPairedDevices, buildSetupVisibleDevices } from '../selectors/setup';
import { useDesktopRuntime } from '../runtime-context';
import { ConfirmationDialog } from './ConfirmationDialog';
import { DiscoveryPanel } from './setup/DiscoveryPanel';
import { PairedDevicesPanel } from './setup/PairedDevicesPanel';

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
  const {
    setup,
    snapshot,
    startManualScan,
    pairDiscoveredNode,
    forgetNode,
    recoverApprovedNode,
  } = useDesktopRuntime();
  const discoveredDevices = setup
    ? buildSetupVisibleDevices(setup, setup.approvedNodes).filter((device) => !device.isPaired)
    : [];
  const pairedDevices = setup ? buildPairedDevices(setup, snapshot) : [];
  const isReadOnly = snapshot?.gateway.mode === 'cloud-http-backend';
  const isScanning =
    !isReadOnly &&
    (setup?.manualScanState === 'scanning' || setup?.manualScanState === 'pairing');
  const pairingCandidateId = setup?.pairingCandidateId ?? null;
  const [pendingPairIds, setPendingPairIds] = useState<Set<string>>(new Set());
  const [pendingRecoverIds, setPendingRecoverIds] = useState<Set<string>>(new Set());
  const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<RemovalTarget | null>(null);
  const lastManualScanError = useRef<string | null>(null);

  useEffect(() => {
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
    if (setup?.manualScanState !== 'pairing') {
      setPendingPairIds(new Set());
    }
  }, [setup?.manualScanState]);

  useEffect(() => {
    const nextError = setup?.manualScanError ?? null;

    if (!nextError || nextError === lastManualScanError.current) {
      return;
    }

    lastManualScanError.current = nextError;
    toast.error(nextError);
  }, [setup?.manualScanError]);

  useEffect(() => {
    if (!removeTarget) {
      return;
    }

    if (!pairedDevices.some((device) => device.id === removeTarget.id)) {
      setRemoveTarget(null);
    }
  }, [pairedDevices, removeTarget]);

  const handleScan = async () => {
    try {
      await startManualScan();
      toast.success('Scan started.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start scan.');
    }
  };

  const handlePairDevice = async (deviceId: string) => {
    setPendingPairIds((current) => addToSet(current, deviceId));

    try {
      await pairDiscoveredNode(deviceId);
      setPendingPairIds((current) => removeFromSet(current, deviceId));
      toast.success('Device paired. Connecting...');
    } catch (error) {
      setPendingPairIds((current) => removeFromSet(current, deviceId));
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
    if (!removeTarget) {
      return;
    }

    const deviceId = removeTarget.id;
    setPendingRemoveIds((current) => addToSet(current, deviceId));

    try {
      await forgetNode(deviceId);
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
      toast.success('Reconnect requested.');
    } catch (error) {
      setPendingRecoverIds((current) => removeFromSet(current, deviceId));
      toast.error(error instanceof Error ? error.message : 'Failed to reconnect device.');
    }
  };

  const removePending = removeTarget ? pendingRemoveIds.has(removeTarget.id) : false;

  return (
    <>
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

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-5xl mx-auto">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-zinc-100">Sensor Setup</h1>
            <p className="text-sm text-zinc-500">Scan and configure Bluetooth devices</p>
          </div>
          <div className="space-y-6">
            <DiscoveryPanel
              devices={discoveredDevices}
              isScanning={isScanning}
              pairingCandidateId={pairingCandidateId}
              pendingPairIds={pendingPairIds}
              disabled={isReadOnly}
              disabledMessage={setup?.adapterIssue ?? null}
              onScan={() => void handleScan()}
              onPairDevice={(deviceId) => void handlePairDevice(deviceId)}
            />
            <PairedDevicesPanel
              devices={pairedDevices}
              pendingRecoverIds={pendingRecoverIds}
              pendingRemoveIds={pendingRemoveIds}
              readOnly={isReadOnly}
              readOnlyMessage={setup?.adapterIssue ?? null}
              onRecoverDevice={(deviceId) => void handleRecoverDevice(deviceId)}
              onRequestUnpairDevice={requestUnpairDevice}
            />
          </div>
        </div>
      </div>
    </>
  );
}
