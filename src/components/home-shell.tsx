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
        description="No device has checked in yet, so the app starts in provisioning mode. Pair the sensor over Bluetooth, choose the gym Wi-Fi, and the live board will take over automatically."
        eyebrow="First device"
        title="Provision the first sensor"
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
