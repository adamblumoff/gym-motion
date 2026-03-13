"use client";

import type { DeviceSummary, MotionEventSummary } from "@/lib/motion";

import { DeviceDashboard } from "./device-dashboard";

type HomeShellProps = {
  initialDevices: DeviceSummary[];
  initialEvents: MotionEventSummary[];
};

export function HomeShell({ initialDevices, initialEvents }: HomeShellProps) {
  return (
    <main>
      <DeviceDashboard initialDevices={initialDevices} initialEvents={initialEvents} />
    </main>
  );
}
