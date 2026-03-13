"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useMemo, useState } from "react";

import { formatLocalTime } from "@/lib/format-time";
import { buildGatewayUrl, fetchGatewayJson } from "@/lib/gateway-connection";
import type {
  DeviceLogStreamPayload,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
} from "@/lib/motion";
import { mergeGatewayDeviceUpdate, mergeLogUpdate } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { GatewayConnectionPanel } from "./gateway-connection-panel";
import { useGatewayConnection } from "./gateway-connection-provider";
import { useLiveStream } from "./live-stream-provider";
import styles from "./device-logs-dashboard.module.css";

function formatLevel(level: DeviceLogSummary["level"]) {
  return level.toUpperCase();
}

function formatMetadata(metadata: DeviceLogSummary["metadata"]) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null;
  }

  return JSON.stringify(metadata, null, 2);
}

type DeviceLogsDashboardProps = {
  initialDevices: GatewayRuntimeDeviceSummary[];
  initialLogs: DeviceLogSummary[];
  initialSelectedDeviceId: string | null;
};

export function DeviceLogsDashboard({
  initialDevices,
  initialLogs,
  initialSelectedDeviceId,
}: DeviceLogsDashboardProps) {
  const router = useRouter();
  const [devices, setDevices] = useState<GatewayRuntimeDeviceSummary[]>(initialDevices);
  const [logs, setLogs] = useState<DeviceLogSummary[]>(initialLogs);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    initialSelectedDeviceId ?? initialDevices[0]?.id ?? null,
  );
  const [status, setStatus] = useState<string | null>(null);
  const { gatewayBaseUrl } = useGatewayConnection();
  const { liveStatus, subscribeToDeviceLogs, subscribeToGatewayDevices } =
    useLiveStream();

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

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

    const deviceId = selectedDeviceId;
    let cancelled = false;

    async function loadLogs() {
      const response = await fetch(
        buildGatewayUrl(
          gatewayBaseUrl,
          `/api/device-logs?deviceId=${encodeURIComponent(deviceId)}&limit=100`,
        ),
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error("Could not load logs.");
      }

      const data = (await response.json()) as { logs: DeviceLogSummary[] };

      if (!cancelled) {
        setLogs(data.logs);
        setStatus(null);
      }
    }

    void loadLogs().catch(() => {
      if (!cancelled) {
        setStatus(`Could not load logs for ${deviceId}.`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [gatewayBaseUrl, initialLogs, selectedDeviceId]);

  useEffect(() => {
    const unsubscribeGatewayDevices = subscribeToGatewayDevices((payload) => {
      setDevices((currentDevices) =>
        mergeGatewayDeviceUpdate(currentDevices, payload.device),
      );
    });

    const unsubscribeLogs = subscribeToDeviceLogs((payload: DeviceLogStreamPayload) => {
      if (payload.log.deviceId === selectedDeviceId) {
        setLogs((currentLogs) => mergeLogUpdate(currentLogs, payload.log));
      }
    });

    return () => {
      unsubscribeGatewayDevices();
      unsubscribeLogs();
    };
  }, [selectedDeviceId, subscribeToDeviceLogs, subscribeToGatewayDevices]);

  function handleDeviceChange(nextDeviceId: string) {
    setSelectedDeviceId(nextDeviceId);
    router.replace(`/logs?deviceId=${encodeURIComponent(nextDeviceId)}`, {
      scroll: false,
    });
  }

  return (
    <AppShell
      description="Gateway-local lifecycle logs for BLE-only sensor nodes, streamed into this console over the same Wi-Fi network."
      eyebrow="Observability"
      status={
        <div className={styles.heroStatus}>
          <span className={styles.heroStatusLabel}>Stream</span>
          <strong>{liveStatus}</strong>
        </div>
      }
      title="Device logs"
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
              <span>Logs below use server received time</span>
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
          <span>Recent logs</span>
          <span>
            {selectedDevice
              ? `${selectedDevice.id} · newest first · server received time`
              : "Waiting for device selection"}
          </span>
        </div>

        {logs.length === 0 ? (
          <div className={styles.emptyState}>
            No logs yet for this device. As soon as the selected gateway records
            node lifecycle events, they will appear here.
          </div>
        ) : (
          <ul className={styles.logList}>
            {logs.map((log) => {
              const metadata = formatMetadata(log.metadata);

              return (
                <li className={styles.logRow} key={log.id}>
                  <div className={styles.logHeader}>
                    <span className={styles.logLevel} data-level={log.level}>
                      {formatLevel(log.level)}
                    </span>
                    <span className={styles.logCode}>{log.code}</span>
                    <span className={styles.logTimeLabel}>Received</span>
                    <span className={styles.logTime}>{formatLocalTime(log.receivedAt)}</span>
                  </div>

                  <p className={styles.logMessage}>{log.message}</p>

                  <div className={styles.logMeta}>
                    <span>firmware {log.firmwareVersion ?? "unknown"}</span>
                    <span>boot {log.bootId ?? "unknown"}</span>
                    {log.deviceTimestamp ? <span>device millis {log.deviceTimestamp}</span> : null}
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
