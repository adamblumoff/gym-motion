"use client";

import type { DeviceSummary, MotionEventSummary } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { DeviceDashboard } from "./device-dashboard";
import { DeviceProvisioningWizard } from "./device-provisioning-wizard";

type HomeShellProps = {
  initialDevices: DeviceSummary[];
  initialEvents: MotionEventSummary[];
};

export function HomeShell({ initialDevices, initialEvents }: HomeShellProps) {
  const devices = initialDevices;

  if (devices.length === 0) {
    return (
      <AppShell
        description="No device has checked in yet. Pair a sensor over Bluetooth to save its identity, then start the laptop BLE gateway so motion updates can flow into the live board."
        eyebrow="First device"
        title="Add the first BLE node"
      >
        <DeviceProvisioningWizard
          mode="first-device"
          onComplete={() => {
            window.location.reload();
          }}
        />
      </AppShell>
    );
  }

  return (
    <main>
      <DeviceDashboard initialDevices={initialDevices} initialEvents={initialEvents} />
    </main>
  );
}
