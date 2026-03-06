"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type {
  DeviceLogStreamPayload,
  DeviceLogSummary,
  DeviceSummary,
  MotionStreamPayload,
} from "@/lib/motion";
import { mergeDeviceUpdate, mergeLogUpdate } from "@/lib/motion";

import styles from "./device-logs-dashboard.module.css";

type DevicesResponse = {
  devices: DeviceSummary[];
};

type DeviceLogsResponse = {
  logs: DeviceLogSummary[];
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatLevel(level: DeviceLogSummary["level"]) {
  return level.toUpperCase();
}

function formatMetadata(metadata: DeviceLogSummary["metadata"]) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return null;
  }

  return JSON.stringify(metadata);
}

export function DeviceLogsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDeviceId = searchParams.get("deviceId");
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [logs, setLogs] = useState<DeviceLogSummary[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    requestedDeviceId,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("Connecting…");

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  useEffect(() => {
    setSelectedDeviceId(requestedDeviceId);
  }, [requestedDeviceId]);

  useEffect(() => {
    let cancelled = false;

    async function loadDevices() {
      const response = await fetch("/api/devices", { cache: "no-store" });

      if (!response.ok) {
        throw new Error("Could not load devices.");
      }

      const data = (await response.json()) as DevicesResponse;

      if (cancelled) {
        return;
      }

      setDevices(data.devices);

      if (!requestedDeviceId && data.devices[0]) {
        const nextDeviceId = data.devices[0].id;
        setSelectedDeviceId(nextDeviceId);
        router.replace(`/logs?deviceId=${encodeURIComponent(nextDeviceId)}`, {
          scroll: false,
        });
      }
    }

    void loadDevices().catch(() => {
      if (!cancelled) {
        setStatus("Could not load devices.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [requestedDeviceId, router]);

  useEffect(() => {
    if (!selectedDeviceId) {
      setLogs([]);
      return;
    }

    const deviceId = selectedDeviceId;
    let cancelled = false;

    async function loadLogs() {
      const response = await fetch(
        `/api/device-logs?deviceId=${encodeURIComponent(deviceId)}&limit=100`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error("Could not load logs.");
      }

      const data = (await response.json()) as DeviceLogsResponse;

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
  }, [selectedDeviceId]);

  useEffect(() => {
    let cancelled = false;
    const eventSource = new EventSource("/api/stream");

    eventSource.addEventListener("motion-update", (rawEvent) => {
      if (cancelled) {
        return;
      }

      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as MotionStreamPayload;

      setDevices((currentDevices) => mergeDeviceUpdate(currentDevices, payload.device));
    });

    eventSource.addEventListener("device-log", (rawEvent) => {
      if (cancelled) {
        return;
      }

      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as DeviceLogStreamPayload;

      if (payload.log.deviceId === selectedDeviceId) {
        setLogs((currentLogs) => mergeLogUpdate(currentLogs, payload.log));
      }
    });

    eventSource.onopen = () => {
      if (!cancelled) {
        setLiveStatus("Live");
      }
    };

    eventSource.onerror = () => {
      if (!cancelled) {
        setLiveStatus("Reconnecting…");
      }
    };

    return () => {
      cancelled = true;
      eventSource.close();
    };
  }, [selectedDeviceId]);

  function handleDeviceChange(nextDeviceId: string) {
    setSelectedDeviceId(nextDeviceId);
    router.replace(`/logs?deviceId=${encodeURIComponent(nextDeviceId)}`, {
      scroll: false,
    });
  }

  return (
    <section className={styles.page}>
      <div className={styles.shell}>
        <nav className={styles.topBar}>
          <div>
            <div className={styles.eyebrow}>Observability</div>
            <h1 className={styles.title}>Device logs</h1>
          </div>
          <div className={styles.topLinks}>
            <Link className={styles.topLink} href="/">
              Live board
            </Link>
            <Link className={styles.topLink} href="/setup">
              Setup
            </Link>
          </div>
        </nav>

        <section className={styles.controls}>
          <label className={styles.controlLabel} htmlFor="device-select">
            Device
          </label>
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
                {device.machineLabel ?? device.id}
              </option>
            ))}
          </select>

          <div className={styles.liveBadge} data-live={liveStatus === "Live"}>
            {liveStatus}
          </div>
        </section>

        {selectedDevice ? (
          <section className={styles.summaryCard}>
            <div>
              <div className={styles.summaryLabel}>Selected device</div>
              <strong>{selectedDevice.machineLabel ?? selectedDevice.id}</strong>
            </div>
            <div className={styles.summaryMeta}>
              <span>{selectedDevice.id}</span>
              <span>{selectedDevice.healthStatus.toUpperCase()}</span>
              <span>firmware {selectedDevice.firmwareVersion}</span>
              <span>boot {selectedDevice.bootId ?? "unknown"}</span>
            </div>
          </section>
        ) : (
          <section className={styles.summaryCard}>
            <div>
              <div className={styles.summaryLabel}>Selected device</div>
              <strong>No device selected yet</strong>
            </div>
          </section>
        )}

        {status ? <p className={styles.status}>{status}</p> : null}

        <section className={styles.logPanel}>
          <div className={styles.panelHeader}>
            <span>Recent logs</span>
            <span>{selectedDeviceId ?? "waiting for device selection"}</span>
          </div>

          {logs.length === 0 ? (
            <div className={styles.emptyState}>
              No logs yet for this device. As soon as it reports Wi-Fi, OTA, or
              motion lifecycle events, they will appear here.
            </div>
          ) : (
            <ul className={styles.logList}>
              {logs.map((log) => {
                const metadata = formatMetadata(log.metadata);

                return (
                  <li className={styles.logRow} key={log.id}>
                    <div className={styles.logHeader}>
                      <span className={styles.logTime}>{formatTime(log.receivedAt)}</span>
                      <span className={styles.logLevel} data-level={log.level}>
                        {formatLevel(log.level)}
                      </span>
                      <span className={styles.logCode}>{log.code}</span>
                    </div>
                    <div className={styles.logMessage}>{log.message}</div>
                    <div className={styles.logMeta}>
                      <span>firmware {log.firmwareVersion ?? "unknown"}</span>
                      <span>boot {log.bootId ?? "unknown"}</span>
                      {log.deviceTimestamp !== null ? (
                        <span>millis {log.deviceTimestamp}</span>
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
      </div>
    </section>
  );
}
