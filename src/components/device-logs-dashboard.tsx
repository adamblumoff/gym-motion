"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useMemo, useState } from "react";

import { formatLocalTime } from "@/lib/format-time";
import { fetchGatewayJson } from "@/lib/gateway-connection";
import type {
  DeviceActivityResponse,
  DeviceActivitySummary,
  DeviceLogStreamPayload,
  GatewayRuntimeDeviceSummary,
  MotionStreamPayload,
} from "@/lib/motion";
import { mergeActivityUpdate, mergeGatewayDeviceUpdate } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { GatewayConnectionPanel } from "./gateway-connection-panel";
import { useGatewayConnection } from "./gateway-connection-provider";
import { useLiveStream } from "./live-stream-provider";
import styles from "./device-logs-dashboard.module.css";

function formatLevel(level: DeviceActivitySummary["level"]) {
  if (!level) {
    return "EVENT";
  }

  return level.toUpperCase();
}

function formatMetadata(metadata: DeviceActivitySummary["metadata"]) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null;
  }

  return JSON.stringify(metadata, null, 2);
}

function motionActivityFromStream(payload: MotionStreamPayload): DeviceActivitySummary | null {
  if (!payload.event) {
    return null;
  }

  return {
    id: `motion-${payload.event.id}`,
    deviceId: payload.event.deviceId,
    kind: "motion",
    title: payload.event.state.toUpperCase(),
    message: `Gateway recorded ${payload.event.state} for ${payload.event.deviceId}.`,
    state: payload.event.state,
    level: null,
    code: "motion.state",
    delta: payload.event.delta,
    eventTimestamp: payload.event.eventTimestamp,
    receivedAt: payload.event.receivedAt,
    bootId: payload.event.bootId,
    firmwareVersion: payload.event.firmwareVersion,
    hardwareId: payload.event.hardwareId,
    metadata:
      payload.event.delta === null ? null : { delta: payload.event.delta },
  };
}

function lifecycleActivityFromStream(payload: DeviceLogStreamPayload): DeviceActivitySummary {
  return {
    id: `log-${payload.log.id}`,
    deviceId: payload.log.deviceId,
    kind: "lifecycle",
    title: payload.log.code ?? payload.log.level.toUpperCase(),
    message: payload.log.message,
    state: null,
    level: payload.log.level,
    code: payload.log.code,
    delta: null,
    eventTimestamp: payload.log.deviceTimestamp,
    receivedAt: payload.log.receivedAt,
    bootId: payload.log.bootId,
    firmwareVersion: payload.log.firmwareVersion,
    hardwareId: payload.log.hardwareId,
    metadata: payload.log.metadata,
  };
}

type DeviceLogsDashboardProps = {
  initialDevices: GatewayRuntimeDeviceSummary[];
  initialActivities: DeviceActivitySummary[];
  initialSelectedDeviceId: string | null;
};

export function DeviceLogsDashboard({
  initialDevices,
  initialActivities,
  initialSelectedDeviceId,
}: DeviceLogsDashboardProps) {
  const router = useRouter();
  const [devices, setDevices] = useState<GatewayRuntimeDeviceSummary[]>(initialDevices);
  const [activities, setActivities] = useState<DeviceActivitySummary[]>(initialActivities);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    initialSelectedDeviceId ?? initialDevices[0]?.id ?? null,
  );
  const [status, setStatus] = useState<string | null>(null);
  const { gatewayBaseUrl } = useGatewayConnection();
  const {
    liveStatus,
    subscribeToDeviceLogs,
    subscribeToGatewayDevices,
    subscribeToMotion,
  } = useLiveStream();

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );
  const visibleActivities = selectedDeviceId ? activities : [];

  useEffect(() => {
    if (!gatewayBaseUrl) {
      return;
    }

    let cancelled = false;

    async function loadDevices() {
      const payload = await fetchGatewayJson<{ devices: GatewayRuntimeDeviceSummary[] }>(
        gatewayBaseUrl,
        "/api/gateway/devices",
      );

      if (cancelled) {
        return;
      }

      startTransition(() => {
        setDevices(payload.devices);
        setSelectedDeviceId((current) => current ?? payload.devices[0]?.id ?? null);
      });
    }

    void loadDevices().catch(() => {
      if (!cancelled) {
        setStatus("Could not load devices from the selected gateway.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [gatewayBaseUrl]);

  useEffect(() => {
    if (!selectedDeviceId) {
      return;
    }

    let cancelled = false;

    async function loadActivity() {
      const deviceId = selectedDeviceId;

      if (!deviceId) {
        return;
      }

      const payload = await fetchGatewayJson<DeviceActivityResponse>(
        gatewayBaseUrl,
        `/api/device-activity?deviceId=${encodeURIComponent(deviceId)}&limit=100`,
      );

      if (!cancelled) {
        setActivities(payload.activities);
        setStatus(null);
      }
    }

    void loadActivity().catch(() => {
      if (!cancelled) {
        setStatus(`Could not load activity for ${selectedDeviceId}.`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [gatewayBaseUrl, selectedDeviceId]);

  useEffect(() => {
    const unsubscribeGatewayDevices = subscribeToGatewayDevices((payload) => {
      setDevices((currentDevices) =>
        mergeGatewayDeviceUpdate(currentDevices, payload.device),
      );
    });

    const unsubscribeLogs = subscribeToDeviceLogs((payload) => {
      if (payload.log.deviceId !== selectedDeviceId) {
        return;
      }

      setActivities((currentActivities) =>
        mergeActivityUpdate(currentActivities, lifecycleActivityFromStream(payload)),
      );
    });

    const unsubscribeMotion = subscribeToMotion((payload) => {
      const activity = motionActivityFromStream(payload);

      if (!activity || activity.deviceId !== selectedDeviceId) {
        return;
      }

      setActivities((currentActivities) =>
        mergeActivityUpdate(currentActivities, activity),
      );
    });

    return () => {
      unsubscribeGatewayDevices();
      unsubscribeLogs();
      unsubscribeMotion();
    };
  }, [selectedDeviceId, subscribeToDeviceLogs, subscribeToGatewayDevices, subscribeToMotion]);

  function handleDeviceChange(nextDeviceId: string) {
    setSelectedDeviceId(nextDeviceId);
    router.replace(`/logs?deviceId=${encodeURIComponent(nextDeviceId)}`, {
      scroll: false,
    });
  }

  return (
    <AppShell
      description="Per-device gateway activity for BLE-only sensor nodes, combining motion transitions with lifecycle events in real time."
      eyebrow="Observability"
      status={
        <div className={styles.heroStatus}>
          <span className={styles.heroStatusLabel}>Stream</span>
          <strong>{liveStatus}</strong>
        </div>
      }
      title="Device activity"
    >
      {status ? <p className={styles.banner}>{status}</p> : null}
      {!selectedDevice ? <GatewayConnectionPanel compact /> : null}

      <section className={styles.controls}>
        <div className={styles.controlBlock}>
          <label className={styles.controlLabel} htmlFor="device-select">
            Device
          </label>
          <div className={styles.selectWrap}>
            <select
              className={styles.select}
              id="device-select"
              onChange={(event) => handleDeviceChange(event.target.value)}
              value={selectedDeviceId ?? ""}
            >
              <option value="" disabled>
                Select a device
              </option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.machineLabel ? `${device.machineLabel} (${device.id})` : device.id}
                </option>
              ))}
            </select>
            <span aria-hidden="true" className={styles.selectChevron} />
          </div>
        </div>

        <div className={styles.liveBadge} data-live={liveStatus === "Gateway live"}>
          {liveStatus}
        </div>
      </section>

      <section className={styles.summaryCard}>
        {selectedDevice ? (
          <>
            <div className={styles.summaryTopRow}>
              <div>
                <div className={styles.summaryLabel}>Selected device</div>
                <strong>{selectedDevice.machineLabel ?? selectedDevice.id}</strong>
              </div>
              <span className={styles.healthBadge} data-health={selectedDevice.healthStatus}>
                {selectedDevice.gatewayConnectionState}
              </span>
            </div>
            <div className={styles.summaryMeta}>
              <span>{selectedDevice.id}</span>
              <span>firmware {selectedDevice.firmwareVersion}</span>
              <span>boot {selectedDevice.bootId ?? "unknown"}</span>
              <span>Activity below uses server received time</span>
            </div>
          </>
        ) : (
          <>
            <div className={styles.summaryLabel}>Selected device</div>
            <strong>No device selected yet</strong>
          </>
        )}
      </section>

      <section className={styles.logPanel}>
        <div className={styles.panelHeader}>
          <span>Recent activity</span>
          <span>
            {selectedDevice
              ? `${selectedDevice.id} · motion + lifecycle · newest first`
              : "Waiting for device selection"}
          </span>
        </div>

        {visibleActivities.length === 0 ? (
          <div className={styles.emptyState}>
            {selectedDevice
              ? "No gateway activity recorded for this node yet. As soon as the gateway sees motion or lifecycle events for it, they will appear here."
              : "The gateway has not seen any devices yet."}
          </div>
        ) : (
          <ul className={styles.logList}>
            {visibleActivities.map((activity) => {
              const metadata = formatMetadata(activity.metadata);

              return (
                <li className={styles.logRow} key={activity.id}>
                  <div className={styles.logHeader}>
                    <span
                      className={styles.logLevel}
                      data-level={activity.kind === "motion" ? "info" : activity.level ?? "info"}
                    >
                      {activity.kind === "motion" ? "MOTION" : formatLevel(activity.level)}
                    </span>
                    <span className={styles.logCode}>
                      {activity.kind === "motion"
                        ? activity.state?.toUpperCase() ?? "MOTION"
                        : activity.code ?? activity.title}
                    </span>
                    <span className={styles.logTimeLabel}>Received</span>
                    <span className={styles.logTime}>{formatLocalTime(activity.receivedAt)}</span>
                  </div>

                  <p className={styles.logMessage}>{activity.message}</p>

                  <div className={styles.logMeta}>
                    <span>{activity.kind}</span>
                    <span>firmware {activity.firmwareVersion ?? "unknown"}</span>
                    <span>boot {activity.bootId ?? "unknown"}</span>
                    {activity.eventTimestamp ? (
                      <span>device millis {activity.eventTimestamp}</span>
                    ) : null}
                  </div>

                  {metadata ? (
                    <pre className={styles.logMetadata}>{metadata}</pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
