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
import styles from "./device-dashboard.module.css";

type DeviceResponse = {
  devices: DeviceSummary[];
};

type EventResponse = {
  events: MotionEventSummary[];
};

function formatState(state: DeviceSummary["lastState"] | MotionEventSummary["state"]) {
  return state.toUpperCase();
}

function formatHealthStatus(status: DeviceSummary["healthStatus"]) {
  return status.toUpperCase();
}

export function DeviceDashboard() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [events, setEvents] = useState<MotionEventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let eventSource: EventSource | null = null;

    async function loadInitialData() {
      try {
        const [devicesResponse, eventsResponse] = await Promise.all([
          fetch("/api/devices", { cache: "no-store" }),
          fetch("/api/events", { cache: "no-store" }),
        ]);

        if (!devicesResponse.ok || !eventsResponse.ok) {
          throw new Error("Could not load devices.");
        }

        const deviceData = (await devicesResponse.json()) as DeviceResponse;
        const eventData = (await eventsResponse.json()) as EventResponse;

        if (!cancelled) {
          setDevices(deviceData.devices);
          setEvents(eventData.events);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("Dashboard is waiting for device data.");
        }
      }
    }

    function connectStream() {
      eventSource = new EventSource("/api/stream");

      eventSource.addEventListener("motion-update", (rawEvent) => {
        if (cancelled) {
          return;
        }

        const event = rawEvent as MessageEvent<string>;
        const payload = JSON.parse(event.data) as MotionStreamPayload;
        const nextEvent = payload.event;

        setDevices((currentDevices) =>
          mergeDeviceUpdate(currentDevices, payload.device),
        );

        if (nextEvent) {
          setEvents((currentEvents) =>
            mergeEventUpdate(currentEvents, nextEvent),
          );
        }

        setError(null);
      });

      eventSource.onerror = () => {
        if (!cancelled) {
          setError("Live connection lost. Reconnecting...");
        }
      };

      eventSource.onopen = () => {
        if (!cancelled) {
          setError(null);
        }
      };
    }

    void loadInitialData();
    connectStream();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, []);

  const [primaryDevice, ...otherDevices] = devices;

  if (!primaryDevice) {
    return (
      <AppShell
        description="The live board wakes up as soon as the first device checks in over the event stream."
        eyebrow="Live board"
        title="Motion status"
      >
        <article className={styles.emptyCard}>
          <h2 className={styles.emptyTitle}>No motion data yet</h2>
          <p className={styles.emptyText}>
            Send an event to <code>/api/ingest</code> and the dashboard will
            light up as soon as the live stream receives it.
          </p>
          {error ? <p className={styles.banner}>{error}</p> : null}
        </article>
      </AppShell>
    );
  }

  return (
    <AppShell
      description="Live motion state, current device health, and the most recent event history."
      eyebrow="Live board"
      status={
        <div className={styles.heroStatus}>
          <span className={styles.heroStatusLabel}>Current sensor</span>
          <strong>{primaryDevice.machineLabel ?? primaryDevice.id}</strong>
        </div>
      }
      title="Motion status"
    >
      {error ? <p className={styles.banner}>{error}</p> : null}

      <div className={styles.deviceId}>{primaryDevice.machineLabel ?? primaryDevice.id}</div>

      <div className={styles.healthRow}>
        <span className={styles.healthBadge} data-health={primaryDevice.healthStatus}>
          {formatHealthStatus(primaryDevice.healthStatus)}
        </span>
        <span className={styles.healthMeta}>
          firmware {primaryDevice.firmwareVersion}
        </span>
      </div>

      <div className={styles.statusBoard}>
        <div
          className={styles.statusLine}
          data-active={primaryDevice.lastState === "moving"}
          data-state="moving"
        >
          MOVING
        </div>
        <div
          className={styles.statusLine}
          data-active={primaryDevice.lastState === "still"}
          data-state="still"
        >
          STILL
        </div>
      </div>

      <div className={styles.metaGrid}>
        <div className={styles.metaCard}>
          <span className={styles.metaLabel}>Device</span>
          <strong>{primaryDevice.id}</strong>
        </div>
        <div className={styles.metaCard}>
          <span className={styles.metaLabel}>Site</span>
          <strong>{primaryDevice.siteId ?? "Unassigned"}</strong>
        </div>
        <div className={styles.metaCard}>
          <span className={styles.metaLabel}>Boot ID</span>
          <strong>{primaryDevice.bootId ?? "Unknown"}</strong>
        </div>
        <div className={styles.metaCard}>
          <span className={styles.metaLabel}>Last contact</span>
          <strong>{formatLocalTime(primaryDevice.updatedAt)}</strong>
        </div>
        <div className={styles.metaCard}>
          <span className={styles.metaLabel}>Heartbeat</span>
          <strong>{formatLocalTime(primaryDevice.lastHeartbeatAt)}</strong>
        </div>
        <div className={styles.metaCard}>
          <span className={styles.metaLabel}>Provisioning</span>
          <strong>{primaryDevice.provisioningState}</strong>
        </div>
      </div>

      <div className={styles.debugMeta}>
        <div>
          Device millis <strong>{primaryDevice.lastSeenAt}</strong>
        </div>
        <div>
          Delta <strong>{primaryDevice.lastDelta ?? "N/A"}</strong>
        </div>
        {otherDevices.length > 0 ? (
          <div>
            Tracking <strong>{devices.length}</strong> devices total
          </div>
        ) : null}
      </div>

      <section className={styles.events}>
        <div className={styles.eventsHeader}>
          <span>Recent events from DB</span>
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
