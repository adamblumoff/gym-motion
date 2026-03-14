"use client";

import type { GatewayRuntimeDeviceSummary, MotionEventSummary } from "@/lib/motion";

import { DeviceDashboard } from "./device-dashboard";

type HomeShellProps = {
  initialDevices: GatewayRuntimeDeviceSummary[];
  initialEvents: MotionEventSummary[];
};

export function HomeShell({ initialDevices, initialEvents }: HomeShellProps) {
  return (
    <main>
      <DeviceDashboard initialDevices={initialDevices} initialEvents={initialEvents} />
    </main>
  );
}
