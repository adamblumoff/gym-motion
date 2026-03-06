"use client";

import { useEffect, useState } from "react";

import type { DeviceSummary, MotionEventSummary } from "@/lib/motion";

import styles from "./device-dashboard.module.css";

const POLL_INTERVAL_MS = 1000;

type DeviceResponse = {
  devices: DeviceSummary[];
};

type EventResponse = {
  events: MotionEventSummary[];
};

function formatState(state: DeviceSummary["lastState"] | MotionEventSummary["state"]) {
  return state.toUpperCase();
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function DeviceDashboard() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [events, setEvents] = useState<MotionEventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
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

    void loadData();

    const intervalId = window.setInterval(() => {
      void loadData();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const [primaryDevice, ...otherDevices] = devices;

  if (!primaryDevice) {
    return (
      <section className={styles.page}>
        <div className={styles.shell}>
          <article className={styles.emptyCard}>
            <h2 className={styles.emptyTitle}>No motion data yet</h2>
            <p className={styles.emptyText}>
              Send an event to <code>/api/ingest</code> and the dashboard will
              light up on the next poll.
            </p>
            {error ? <p className={styles.pollingNote}>{error}</p> : null}
          </article>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.deviceId}>{primaryDevice.id}</div>

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

        <div className={styles.meta}>
          <div>
            Last seen <strong>{formatTime(primaryDevice.updatedAt)}</strong>
          </div>
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
          <div className={styles.eventsHeader}>Recent events from DB</div>
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
                  <span>millis {event.eventTimestamp}</span>
                  <span>{formatTime(event.receivedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className={styles.pollingNote}>Polling every second.</p>
      </div>
    </section>
  );
}
