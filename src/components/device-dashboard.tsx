"use client";

import { useEffect, useState } from "react";

import type {
  DeviceSummary,
  MotionEventSummary,
  MotionStreamPayload,
} from "@/lib/motion";
import { formatLocalTime } from "@/lib/format-time";
import { mergeDeviceUpdate, mergeEventUpdate } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { useLiveStream } from "./live-stream-provider";
import styles from "./device-dashboard.module.css";

function formatState(state: DeviceSummary["lastState"] | MotionEventSummary["state"]) {
  return state.toUpperCase();
}

function formatHealthStatus(status: DeviceSummary["healthStatus"]) {
  return status.toUpperCase();
}

type DeviceDashboardProps = {
  initialDevices: DeviceSummary[];
  initialEvents: MotionEventSummary[];
};

export function DeviceDashboard({
  initialDevices,
  initialEvents,
}: DeviceDashboardProps) {
  const [devices, setDevices] = useState<DeviceSummary[]>(initialDevices);
  const [events, setEvents] = useState<MotionEventSummary[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const { subscribeToMotion } = useLiveStream();

  useEffect(() => {
    return subscribeToMotion((payload: MotionStreamPayload) => {
      const nextEvent = payload.event;

      setDevices((currentDevices) =>
        mergeDeviceUpdate(currentDevices, payload.device),
      );

      if (nextEvent) {
        setEvents((currentEvents) => mergeEventUpdate(currentEvents, nextEvent));
      }

      setError(null);
    });
  }, [subscribeToMotion]);

  if (devices.length === 0) {
    return (
      <AppShell
        description="The live board wakes up as soon as the BLE gateway forwards the first device update."
        eyebrow="Live board"
        title="Motion status"
      >
        <article className={styles.emptyCard}>
          <h2 className={styles.emptyTitle}>No motion data yet</h2>
          <p className={styles.emptyText}>
            Start the BLE gateway, then move a node so it can forward a packet to
            <code> /api/ingest</code>.
          </p>
          {error ? <p className={styles.banner}>{error}</p> : null}
        </article>
      </AppShell>
    );
  }

  const movingCount = devices.filter((device) => device.lastState === "moving").length;
  const onlineCount = devices.filter((device) => device.healthStatus === "online").length;

  return (
    <AppShell
      description="Live multi-device motion state, BLE gateway health-by-proxy, and the most recent forwarded events."
      eyebrow="Live board"
      status={
        <div className={styles.heroStatus}>
          <span className={styles.heroStatusLabel}>Fleet</span>
          <strong>{devices.length} devices</strong>
          <span className={styles.heroStatusDivider} />
          <strong>{movingCount} moving</strong>
          <span className={styles.heroStatusDivider} />
          <strong>{onlineCount} online</strong>
        </div>
      }
      title="Motion status"
    >
      {error ? <p className={styles.banner}>{error}</p> : null}

      <section className={styles.deviceGrid}>
        {devices.map((device) => (
          <article className={styles.deviceCard} key={device.id}>
            <div className={styles.cardHeader}>
              <div>
                <div className={styles.deviceId}>{device.id}</div>
                <h2 className={styles.deviceTitle}>{device.machineLabel ?? device.id}</h2>
              </div>
              <span className={styles.healthBadge} data-health={device.healthStatus}>
                {formatHealthStatus(device.healthStatus)}
              </span>
            </div>

            <div className={styles.stateBlock} data-state={device.lastState}>
              {formatState(device.lastState)}
            </div>

            <div className={styles.metaGrid}>
              <div className={styles.metaCard}>
                <span className={styles.metaLabel}>Zone</span>
                <strong>{device.siteId ?? "Unassigned"}</strong>
              </div>
              <div className={styles.metaCard}>
                <span className={styles.metaLabel}>Firmware</span>
                <strong>{device.firmwareVersion}</strong>
              </div>
              <div className={styles.metaCard}>
                <span className={styles.metaLabel}>Last contact</span>
                <strong>{formatLocalTime(device.updatedAt)}</strong>
              </div>
              <div className={styles.metaCard}>
                <span className={styles.metaLabel}>Device millis</span>
                <strong>{device.lastSeenAt}</strong>
              </div>
            </div>

            <div className={styles.debugMeta}>
              <div>
                Delta <strong>{device.lastDelta ?? "N/A"}</strong>
              </div>
              <div>
                Update status <strong>{device.updateStatus}</strong>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className={styles.events}>
        <div className={styles.eventsHeader}>
          <span>Recent forwarded events</span>
          <span>Received (server time)</span>
        </div>
        {events.length === 0 ? (
          <div className={styles.eventsEmpty}>No events in the database yet.</div>
        ) : (
          <ul className={styles.eventsList}>
            {events.map((event) => (
              <li className={styles.eventRow} key={event.id}>
                <span>{event.deviceId}</span>
                <span className={styles.eventState} data-state={event.state}>
                  {formatState(event.state)}
                </span>
                <span>{event.firmwareVersion ?? "unknown"}</span>
                <span>millis {event.eventTimestamp}</span>
                <span>{formatLocalTime(event.receivedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
