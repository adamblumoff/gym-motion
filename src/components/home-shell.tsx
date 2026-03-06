"use client";

import { useEffect, useState } from "react";

import type { DeviceSummary } from "@/lib/motion";

import { DeviceDashboard } from "./device-dashboard";
import { DeviceProvisioningWizard } from "./device-provisioning-wizard";

type DevicesResponse = {
  devices: DeviceSummary[];
};

export function HomeShell() {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDevices() {
      try {
        const response = await fetch("/api/devices", { cache: "no-store" });

        if (!response.ok) {
          throw new Error("Could not load devices.");
        }

        const data = (await response.json()) as DevicesResponse;

        if (!cancelled) {
          setDevices(data.devices);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load devices.");
          setDevices([]);
        }
      }
    }

    void loadDevices();

    return () => {
      cancelled = true;
    };
  }, []);

  if (devices === null) {
    return <main>Loading…</main>;
  }

  if (devices.length === 0) {
    return (
      <main>
        <DeviceProvisioningWizard
          mode="first-device"
          onComplete={() => {
            window.location.reload();
          }}
        />
        {error ? <p>{error}</p> : null}
      </main>
    );
  }

  return (
    <main>
      <DeviceDashboard />
    </main>
  );
}
