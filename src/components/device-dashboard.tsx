"use client";

import { useEffect, useState } from "react";

import type { DeviceSummary } from "@/lib/motion";

import styles from "./device-dashboard.module.css";

const POLL_INTERVAL_MS = 3000;

type DeviceResponse = {
  devices: DeviceSummary[];
};

function formatState(state: DeviceSummary["lastState"]) {
  return state.toUpperCase();
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function DeviceCard({ device }: { device: DeviceSummary }) {
  return (
    <article className={styles.deviceCard} data-state={device.lastState}>
      <div className={styles.deviceTop}>
        <div>
          <div className={styles.deviceId}>{device.id}</div>
          <div className={styles.deviceState}>{formatState(device.lastState)}</div>
        </div>
        <div className={styles.statusDot} aria-hidden="true" />
      </div>
      <div className={styles.deviceMeta}>
        <div>
          <div className={styles.metaLabel}>Last seen</div>
          <div className={styles.metaValue}>{formatTime(device.lastSeenAt)}</div>
        </div>
        <div>
          <div className={styles.metaLabel}>Delta</div>
          <div className={styles.metaValue}>{device.lastDelta ?? "N/A"}</div>
        </div>
      </div>
    </article>
  );
}

export function DeviceDashboard() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDevices() {
      try {
        const response = await fetch("/api/devices", { cache: "no-store" });

        if (!response.ok) {
          throw new Error("Could not load devices.");
        }

        const data = (await response.json()) as DeviceResponse;

        if (!cancelled) {
          setDevices(data.devices);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("Dashboard is waiting for device data.");
        }
      }
    }

    void loadDevices();

    const intervalId = window.setInterval(() => {
      void loadDevices();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const [primaryDevice, ...otherDevices] = devices;

  if (!primaryDevice) {
    return (
      <section className={styles.stack}>
        <article className={styles.emptyCard}>
          <h2 className={styles.emptyTitle}>No motion data yet</h2>
          <p className={styles.emptyText}>
            Send an event to <code>/api/ingest</code> and the dashboard will
            light up on the next poll.
          </p>
          {error ? <p className={styles.pollingNote}>{error}</p> : null}
        </article>
      </section>
    );
  }

  return (
    <section className={styles.stack}>
      <article className={styles.heroCard} data-state={primaryDevice.lastState}>
        <div className={styles.heroTop}>
          <div>
            <div className={styles.deviceId}>{primaryDevice.id}</div>
            <div className={styles.heroState}>
              {formatState(primaryDevice.lastState)}
            </div>
          </div>
          <div className={styles.pill}>{formatState(primaryDevice.lastState)}</div>
        </div>

        <div className={styles.heroMeta}>
          <div>
            <div className={styles.metaLabel}>Last seen</div>
            <div className={styles.metaValue}>
              {formatTime(primaryDevice.lastSeenAt)}
            </div>
          </div>
          <div>
            <div className={styles.metaLabel}>Delta</div>
            <div className={styles.metaValue}>
              {primaryDevice.lastDelta ?? "N/A"}
            </div>
          </div>
        </div>
      </article>

      {otherDevices.length > 0 ? (
        <div className={styles.grid}>
          {otherDevices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      ) : null}

      <p className={styles.pollingNote}>Polling every 3 seconds.</p>
    </section>
  );
}
