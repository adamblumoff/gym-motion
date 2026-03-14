"use client";

import { startTransition, useEffect, useMemo, useState } from "react";

import { formatLocalTime } from "@/lib/format-time";
import { fetchGatewayJson, buildGatewayUrl } from "@/lib/gateway-connection";
import type { GatewayRuntimeDeviceSummary } from "@/lib/motion";
import { mergeGatewayDeviceUpdate } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { GatewayConnectionPanel } from "./gateway-connection-panel";
import { useGatewayConnection } from "./gateway-connection-provider";
import { useLiveStream } from "./live-stream-provider";
import styles from "./setup-dashboard.module.css";

type Drafts = Record<
  string,
  {
    machineLabel: string;
    siteId: string;
    hardwareId: string;
  }
>;

function createDrafts(devices: GatewayRuntimeDeviceSummary[]): Drafts {
  return Object.fromEntries(
    devices.map((device) => [
      device.id,
      {
        machineLabel: device.machineLabel ?? "",
        siteId: device.siteId ?? "",
        hardwareId: device.hardwareId ?? "",
      },
    ]),
  );
}

function formatOtaStatus(status: GatewayRuntimeDeviceSummary["otaStatus"]) {
  return status.replaceAll("-", " ");
}

function formatProgress(device: GatewayRuntimeDeviceSummary) {
  if (!device.otaTotalBytes) {
    return "Waiting";
  }

  const sentBytes = device.otaProgressBytesSent ?? 0;
  const percent = Math.min(
    100,
    Math.round((sentBytes / device.otaTotalBytes) * 100),
  );

  return `${percent}% (${sentBytes}/${device.otaTotalBytes} bytes)`;
}

type SetupDashboardProps = {
  initialDevices: GatewayRuntimeDeviceSummary[];
};

export function SetupDashboard({ initialDevices }: SetupDashboardProps) {
  const [devices, setDevices] = useState<GatewayRuntimeDeviceSummary[]>(initialDevices);
  const [drafts, setDrafts] = useState<Drafts>(() => createDrafts(initialDevices));
  const [status, setStatus] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    initialDevices[0]?.id ?? null,
  );
  const { gatewayBaseUrl } = useGatewayConnection();
  const { gatewayHealth, liveStatus, subscribeToGatewayDevices } = useLiveStream();

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
        setDrafts(createDrafts(payload.devices));
        setSelectedDeviceId((current) => current ?? payload.devices[0]?.id ?? null);
        setStatus(null);
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
    return subscribeToGatewayDevices((payload) => {
      setDevices((currentDevices) =>
        mergeGatewayDeviceUpdate(currentDevices, payload.device),
      );
      setSelectedDeviceId((currentSelectedId) =>
        currentSelectedId ?? payload.device.id,
      );
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [payload.device.id]: currentDrafts[payload.device.id] ?? {
          machineLabel: payload.device.machineLabel ?? "",
          siteId: payload.device.siteId ?? "",
          hardwareId: payload.device.hardwareId ?? "",
        },
      }));
    });
  }, [subscribeToGatewayDevices]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  const selectedDraft = selectedDevice ? drafts[selectedDevice.id] : null;
  const onlineCount = devices.filter(
    (device) => device.gatewayConnectionState === "connected",
  ).length;
  const fleetStatus =
    devices.length === 1
      ? "1 device tracked"
      : `${devices.length} devices tracked`;
  const fleetHealth =
    onlineCount === 1 ? "1 online" : `${onlineCount} online`;

  function updateDraft(
    deviceId: string,
    nextField: keyof Drafts[string],
    value: string,
  ) {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [deviceId]: {
        ...(currentDrafts[deviceId] ?? {
          machineLabel: "",
          siteId: "",
          hardwareId: "",
        }),
        [nextField]: value,
      },
    }));
  }

  async function handleDeviceSave(deviceId: string) {
    const draft = drafts[deviceId];

    const response = await fetch(buildGatewayUrl(gatewayBaseUrl, `/api/devices/${deviceId}`), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        machineLabel: draft.machineLabel || null,
        siteId: draft.siteId || null,
        hardwareId: draft.hardwareId || null,
      }),
    });

    if (!response.ok) {
      setStatus(`Failed to save ${deviceId}.`);
      return;
    }

    const data = (await response.json()) as {
      device: Pick<
        GatewayRuntimeDeviceSummary,
        "id" | "machineLabel" | "siteId" | "hardwareId" | "provisioningState" | "updateStatus"
      >;
    };

    setDevices((currentDevices) =>
      currentDevices.map((device) =>
        device.id === deviceId
          ? {
              ...device,
              machineLabel: data.device.machineLabel ?? null,
              siteId: data.device.siteId ?? null,
              hardwareId: data.device.hardwareId ?? null,
              provisioningState: data.device.provisioningState,
              updateStatus: data.device.updateStatus,
            }
          : device,
      ),
    );
    setStatus(`Saved ${deviceId}.`);
  }

  async function handleDeviceDelete(deviceId: string) {
    const confirmed = window.confirm(
      `Delete ${deviceId} from the selected gateway record?`,
    );

    if (!confirmed) {
      return;
    }

    const response = await fetch(buildGatewayUrl(gatewayBaseUrl, `/api/devices/${deviceId}`), {
      method: "DELETE",
    });

    if (!response.ok) {
      setStatus(`Failed to delete ${deviceId}.`);
      return;
    }

    let nextSelectedDeviceId: string | null = null;

    setDevices((currentDevices) => {
      const nextDevices = currentDevices.filter((device) => device.id !== deviceId);
      nextSelectedDeviceId = nextDevices[0]?.id ?? null;
      return nextDevices;
    });
    setDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      delete nextDrafts[deviceId];
      return nextDrafts;
    });
    setSelectedDeviceId(nextSelectedDeviceId);

    setStatus(`Deleted ${deviceId} from the selected gateway.`);
  }

  return (
    <AppShell
      description="Monitor the Linux gateway, review known BLE nodes, and manage the metadata the gateway uses for the live board."
      eyebrow="Gateway"
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
          <strong>{fleetStatus}</strong>
          <span className={styles.heroStatusDivider} />
          <strong>{fleetHealth}</strong>
        </div>
      }
      title="Gateway control"
    >
      {status ? <p className={styles.banner}>{status}</p> : null}

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <section className={styles.panel}>
            <div className={styles.panelEyebrow}>Primary action</div>
            <h2 className={styles.panelTitle}>Gateway status</h2>
            <p className={styles.panelCopy}>
              This page automatically follows the Linux gateway that served it.
              The gateway owns BLE discovery, reconnects to known nodes, and
              streams that runtime state here in real time.
            </p>
            <GatewayConnectionPanel compact />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelEyebrow}>Gateway actions</div>
            <h2 className={styles.panelTitle}>Operational controls</h2>
            <p className={styles.panelCopy}>
              BLE nodes connect automatically when the gateway sees them. Future
              actions like restarting the gateway can live here without requiring a
              separate setup route. OTA progress and failures also surface here in
              real time.
            </p>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelEyebrow}>Device roster</div>
            <ul className={styles.rosterList}>
              {devices.length === 0 ? (
                <li className={styles.rosterEmpty}>No devices have checked in yet.</li>
              ) : (
                devices.map((device) => {
                  return (
                    <li key={device.id}>
                      <button
                        className={styles.rosterButton}
                        data-active={device.id === selectedDeviceId}
                        onClick={() => {
                          setSelectedDeviceId(device.id);
                        }}
                        type="button"
                      >
                        <div className={styles.rosterIdentity}>
                          <strong>{device.machineLabel ?? device.id}</strong>
                          <span>{device.id}</span>
                        </div>
                        <span className={styles.healthBadge} data-health={device.healthStatus}>
                          {device.gatewayConnectionState}
                        </span>
                        <span className={styles.detailChip}>
                          {device.otaTargetVersion
                            ? `fw ${device.firmwareVersion} -> ${device.otaTargetVersion}`
                            : `fw ${device.firmwareVersion}`}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </section>
        </aside>

        <div className={styles.mainPane}>
          {selectedDevice && selectedDraft ? (
            <section className={styles.detailPanel}>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.panelEyebrow}>Selected device</div>
                  <h2 className={styles.detailTitle}>
                    {selectedDevice.machineLabel ?? selectedDevice.id}
                  </h2>
                  <p className={styles.detailCopy}>
                    {selectedDevice.id} · installed {selectedDevice.firmwareVersion}
                    {selectedDevice.otaTargetVersion
                      ? ` · target ${selectedDevice.otaTargetVersion}`
                      : ""}
                  </p>
                </div>
                <div className={styles.detailBadges}>
                  <span className={styles.healthBadge} data-health={selectedDevice.healthStatus}>
                    {selectedDevice.gatewayConnectionState}
                  </span>
                  <span className={styles.detailChip}>
                    OTA {formatOtaStatus(selectedDevice.otaStatus)}
                  </span>
                </div>
              </div>

              <div className={styles.formGrid}>
                <label className={styles.field}>
                  <span>Machine label</span>
                  <input
                    onChange={(event) =>
                      updateDraft(selectedDevice.id, "machineLabel", event.target.value)
                    }
                    value={selectedDraft.machineLabel}
                  />
                </label>

                <label className={styles.field}>
                  <span>Zone</span>
                  <input
                    onChange={(event) =>
                      updateDraft(selectedDevice.id, "siteId", event.target.value)
                    }
                    value={selectedDraft.siteId}
                  />
                </label>

                <label className={styles.field}>
                  <span>Hardware ID</span>
                  <input
                    onChange={(event) =>
                      updateDraft(selectedDevice.id, "hardwareId", event.target.value)
                    }
                    value={selectedDraft.hardwareId}
                  />
                </label>
              </div>

              <div className={styles.telemetryGrid}>
                <div>
                  <span className={styles.telemetryLabel}>Installed firmware</span>
                  <strong>{selectedDevice.firmwareVersion}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Target firmware</span>
                  <strong>{selectedDevice.otaTargetVersion ?? "None queued"}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>OTA status</span>
                  <strong>{formatOtaStatus(selectedDevice.otaStatus)}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>OTA phase</span>
                  <strong>{selectedDevice.otaLastPhase ?? "Idle"}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>OTA progress</span>
                  <strong>{formatProgress(selectedDevice)}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Last OTA update</span>
                  <strong>{formatLocalTime(selectedDevice.otaUpdatedAt)}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Boot ID</span>
                  <strong>{selectedDevice.bootId ?? "unknown"}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Gateway link</span>
                  <strong>{selectedDevice.gatewayConnectionState}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Last advertisement</span>
                  <strong>{formatLocalTime(selectedDevice.gatewayLastAdvertisementAt)}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Last BLE packet</span>
                  <strong>{formatLocalTime(selectedDevice.gatewayLastTelemetryAt)}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Provisioning</span>
                  <strong>{selectedDevice.provisioningState}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Update status</span>
                  <strong>{selectedDevice.updateStatus}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Activity scope</span>
                  <strong>Node-specific</strong>
                </div>
              </div>

              <section className={styles.otaPanel}>
                <div className={styles.panelEyebrow}>OTA session</div>
                <h3 className={styles.otaTitle}>Gateway firmware visibility</h3>
                <p className={styles.otaCopy}>
                  The installed firmware only changes after the node confirms the
                  update. Until then, watch the OTA status, phase, and per-device
                  activity log for the exact point where the transfer is waiting.
                </p>
                <div className={styles.otaMeta}>
                  <span>Gateway status {formatOtaStatus(selectedDevice.otaStatus)}</span>
                  <span>Node status {selectedDevice.otaLastStatusMessage ?? "None yet"}</span>
                </div>
                {selectedDevice.otaFailureDetail ? (
                  <p className={styles.otaFailure}>{selectedDevice.otaFailureDetail}</p>
                ) : null}
              </section>

              <div className={styles.detailActions}>
                <button
                  className={styles.primaryButton}
                  onClick={() => void handleDeviceSave(selectedDevice.id)}
                  type="button"
                >
                  Save changes
                </button>
                <button
                  className={styles.secondaryButton}
                  onClick={() => void handleDeviceDelete(selectedDevice.id)}
                  type="button"
                >
                  Delete device
                </button>
              </div>
            </section>
          ) : (
            <section className={styles.emptyDetail}>
              <div className={styles.panelEyebrow}>No selection</div>
              <h2 className={styles.panelTitle}>Choose a gateway-backed sensor</h2>
              <p className={styles.panelCopy}>
                As soon as the gateway sees a BLE node, it will appear here for
                labeling, lifecycle tracking, and reconnect monitoring.
              </p>
              <GatewayConnectionPanel compact />
            </section>
          )}
        </div>
      </div>
    </AppShell>
  );
}
