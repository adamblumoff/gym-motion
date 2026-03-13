"use client";

import { startTransition, useEffect, useState } from "react";

import { fetchGatewayJson } from "@/lib/gateway-connection";
import type {
  GatewayRuntimeDeviceSummary,
  MotionEventSummary,
  MotionStreamPayload,
} from "@/lib/motion";
import { formatLocalTime } from "@/lib/format-time";
import { mergeEventUpdate, mergeGatewayDeviceUpdate } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { GatewayConnectionPanel } from "./gateway-connection-panel";
import { useGatewayConnection } from "./gateway-connection-provider";
import { useLiveStream } from "./live-stream-provider";
import styles from "./device-dashboard.module.css";

function formatState(
  state: GatewayRuntimeDeviceSummary["lastState"] | MotionEventSummary["state"],
) {
  return state.toUpperCase();
}

function formatGatewayConnectionStatus(
  status: GatewayRuntimeDeviceSummary["gatewayConnectionState"],
) {
  return status.replaceAll("-", " ").toUpperCase();
}

type DeviceDashboardProps = {
  initialDevices: GatewayRuntimeDeviceSummary[];
  initialEvents: MotionEventSummary[];
};

export function DeviceDashboard({
  initialDevices,
  initialEvents,
}: DeviceDashboardProps) {
  const [devices, setDevices] = useState<GatewayRuntimeDeviceSummary[]>(initialDevices);
  const [events, setEvents] = useState<MotionEventSummary[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const { gatewayBaseUrl } = useGatewayConnection();
  const { gatewayHealth, liveStatus, subscribeToGatewayDevices, subscribeToMotion } =
    useLiveStream();

  useEffect(() => {
    if (!gatewayBaseUrl) {
      return;
    }

    let cancelled = false;

    async function loadDashboard() {
      const [devicePayload, eventPayload] = await Promise.all([
        fetchGatewayJson<{ devices: GatewayRuntimeDeviceSummary[] }>(
          gatewayBaseUrl,
          "/api/gateway/devices",
        ),
        fetchGatewayJson<{ events: MotionEventSummary[] }>(gatewayBaseUrl, "/api/events"),
      ]);

      if (cancelled) {
        return;
      }

      startTransition(() => {
        setDevices(devicePayload.devices);
        setEvents(eventPayload.events);
        setError(null);
      });
    }

    void loadDashboard().catch(() => {
      if (!cancelled) {
        setError("Could not load live data from the selected gateway.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [gatewayBaseUrl]);

  useEffect(() => {
    const unsubscribeGatewayDevices = subscribeToGatewayDevices((payload) => {
      setDevices((currentDevices) =>
        mergeGatewayDeviceUpdate(currentDevices, payload.device),
      );
      setError(null);
    });

    const unsubscribeMotion = subscribeToMotion((payload: MotionStreamPayload) => {
      const nextEvent = payload.event;
      if (nextEvent) {
        setEvents((currentEvents) => mergeEventUpdate(currentEvents, nextEvent));
      }
      setError(null);
    });

    return () => {
      unsubscribeGatewayDevices();
      unsubscribeMotion();
    };
  }, [subscribeToGatewayDevices, subscribeToMotion]);

  if (devices.length === 0) {
    return (
      <AppShell
        description="This live board follows the Linux gateway that served the page. As soon as that gateway sees a BLE node and receives telemetry, the board updates automatically."
        eyebrow="Live board"
        title="Motion status"
      >
        <article className={styles.emptyCard}>
          <h2 className={styles.emptyTitle}>No motion data yet</h2>
          <p className={styles.emptyText}>
            {gatewayHealth?.gateway.adapterState === "poweredOn"
              ? "The gateway is up and scanning. Power the BLE node or move it so the gateway can connect and forward telemetry."
              : "The frontend is waiting for the local gateway runtime. Start the gateway on the Linux box and this board will wake up automatically."}
          </p>
          <GatewayConnectionPanel compact />
          {error ? <p className={styles.banner}>{error}</p> : null}
        </article>
      </AppShell>
    );
  }

  const movingCount = devices.filter((device) => device.lastState === "moving").length;
  const onlineCount = devices.filter(
    (device) => device.gatewayConnectionState === "connected",
  ).length;

  return (
    <AppShell
      description="Live multi-device motion state from the local Linux gateway, plus the most recent forwarded BLE node events on this Wi-Fi network."
      eyebrow="Live board"
      status={
        <div className={styles.heroStatus}>
          <span className={styles.heroStatusLabel}>Gateway</span>
          <strong>{liveStatus}</strong>
          <span className={styles.heroStatusDivider} />
          <strong>{gatewayHealth?.gateway.connectedNodeCount ?? onlineCount} connected</strong>
          <span className={styles.heroStatusDivider} />
          <strong>{gatewayHealth?.gateway.reconnectingNodeCount ?? 0} reconnecting</strong>
          <span className={styles.heroStatusDivider} />
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
              <span
                className={styles.healthBadge}
                data-health={
                  liveStatus === "Gateway live"
                    ? device.healthStatus
                    : "offline"
                }
              >
                {liveStatus === "Gateway live"
                  ? formatGatewayConnectionStatus(device.gatewayConnectionState)
                  : "GATEWAY OFFLINE"}
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
                <span className={styles.metaLabel}>Gateway link</span>
                <strong>{formatGatewayConnectionStatus(device.gatewayConnectionState)}</strong>
              </div>
              <div className={styles.metaCard}>
                <span className={styles.metaLabel}>Last BLE packet</span>
                <strong>
                  {device.gatewayLastTelemetryAt
                    ? formatLocalTime(device.gatewayLastTelemetryAt)
                    : "Waiting"}
                </strong>
              </div>
            </div>

            <div className={styles.debugMeta}>
              <div>
                Gateway seen <strong>{formatLocalTime(device.updatedAt)}</strong>
              </div>
              <div>
                {device.gatewayDisconnectReason
                  ? <>Last link loss <strong>{device.gatewayDisconnectReason}</strong></>
                  : <>Update status <strong>{device.updateStatus}</strong></>}
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
