"use client";

import { useEffect, useState } from "react";

import type { DeviceSummary } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { DeviceDashboard } from "./device-dashboard";
import { DeviceProvisioningWizard } from "./device-provisioning-wizard";
import styles from "./home-shell.module.css";

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
    return (
      <AppShell
        description="Initializing the live board and checking for provisioned devices."
        eyebrow="Live board"
        title="Motion status"
      >
        <section className={styles.loadingPanel}>
          <div aria-hidden="true" className={styles.loadingPulse} />
          <div>
            <strong>Loading device state</strong>
            <p>Pulling the latest device summary and opening the live stream.</p>
          </div>
        </section>
      </AppShell>
    );
  }

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
        {error ? <p className={styles.error}>{error}</p> : null}
      </AppShell>
    );
  }

  return (
    <main>
      <DeviceDashboard />
    </main>
  );
}
