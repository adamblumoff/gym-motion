"use client";

import { useEffect, useMemo, useState } from "react";

import { formatLocalTime } from "@/lib/format-time";
import type { DeviceSummary, MotionStreamPayload } from "@/lib/motion";
import { mergeDeviceUpdate } from "@/lib/motion";

import { AppShell } from "./app-shell";
import { DeviceProvisioningWizard } from "./device-provisioning-wizard";
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

function createDrafts(devices: DeviceSummary[]): Drafts {
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

type SetupDashboardProps = {
  initialDevices: DeviceSummary[];
};

export function SetupDashboard({ initialDevices }: SetupDashboardProps) {
  const [devices, setDevices] = useState<DeviceSummary[]>(initialDevices);
  const [drafts, setDrafts] = useState<Drafts>(() => createDrafts(initialDevices));
  const [status, setStatus] = useState<string | null>(null);
  const [showProvisioningWizard, setShowProvisioningWizard] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    initialDevices[0]?.id ?? null,
  );
  const { subscribeToMotion } = useLiveStream();

  useEffect(() => {
    return subscribeToMotion((payload: MotionStreamPayload) => {
      setDevices((currentDevices) =>
        mergeDeviceUpdate(currentDevices, payload.device),
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
  }, [subscribeToMotion]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  const selectedDraft = selectedDevice ? drafts[selectedDevice.id] : null;
  const onlineCount = devices.filter((device) => device.healthStatus === "online").length;
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

    const response = await fetch(`/api/devices/${deviceId}`, {
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

    const data = (await response.json()) as { device: DeviceSummary };

    setDevices((currentDevices) => mergeDeviceUpdate(currentDevices, data.device));
    setStatus(`Saved ${deviceId}.`);
  }

  async function handleDeviceDelete(deviceId: string) {
    const confirmed = window.confirm(
      `Delete ${deviceId} from the app? After deletion, hold IO0 while tapping EN so the sensor clears saved Wi-Fi and re-enters BLE setup mode.`,
    );

    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/devices/${deviceId}`, {
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

    if (!nextSelectedDeviceId) {
      setShowProvisioningWizard(true);
    }

    setStatus(
      `Deleted ${deviceId}. Hold IO0 while tapping EN so the sensor clears saved Wi-Fi and re-enters BLE setup mode.`,
    );
  }

  return (
    <AppShell
      description="Add sensors, label installed machines, and check provisioning health without leaving the operator console."
      eyebrow="Setup"
      status={
        <div className={styles.heroStatus}>
          <span className={styles.heroStatusLabel}>Fleet</span>
          <strong>{fleetStatus}</strong>
          <span className={styles.heroStatusDivider} />
          <strong>{fleetHealth}</strong>
        </div>
      }
      title="Provision & manage sensors"
    >
      {status ? <p className={styles.banner}>{status}</p> : null}

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <section className={styles.panel}>
            <div className={styles.panelEyebrow}>Primary action</div>
            <h2 className={styles.panelTitle}>Add or re-add a device</h2>
            <p className={styles.panelCopy}>
              Provisioning uses Bluetooth from this browser and reuses the last
              remembered gym Wi-Fi profile when available.
            </p>
            <button
              className={styles.primaryButton}
              onClick={() => setShowProvisioningWizard(true)}
              type="button"
            >
              Add device
            </button>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelEyebrow}>Re-provision</div>
            <h2 className={styles.panelTitle}>IO0 + EN reset</h2>
            <p className={styles.panelCopy}>
              Deleting a device in the app only removes the server record. To run
              setup again on the same ESP32, hold <strong>IO0</strong> while tapping{" "}
              <strong>EN</strong> so it clears saved Wi-Fi and returns to BLE setup
              mode. On some boards that IO0 button can look like <strong>0</strong> or{" "}
              <strong>100</strong>.
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
                          setShowProvisioningWizard(false);
                          setSelectedDeviceId(device.id);
                        }}
                        type="button"
                      >
                        <div className={styles.rosterIdentity}>
                          <strong>{device.machineLabel ?? device.id}</strong>
                          <span>{device.id}</span>
                        </div>
                        <span className={styles.healthBadge} data-health={device.healthStatus}>
                          {device.healthStatus}
                        </span>
                        <span className={styles.detailChip}>
                          fw {device.firmwareVersion}
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
          {showProvisioningWizard ? (
            <DeviceProvisioningWizard
              mode={devices.length === 0 ? "first-device" : "add-device"}
              onCancel={() => setShowProvisioningWizard(false)}
              onComplete={(device) => {
                setShowProvisioningWizard(false);
                setSelectedDeviceId(device.id);
                setStatus("Device provisioned successfully.");
              }}
            />
          ) : selectedDevice && selectedDraft ? (
            <section className={styles.detailPanel}>
              <div className={styles.detailHeader}>
                <div>
                  <div className={styles.panelEyebrow}>Selected device</div>
                  <h2 className={styles.detailTitle}>
                    {selectedDevice.machineLabel ?? selectedDevice.id}
                  </h2>
                  <p className={styles.detailCopy}>
                    {selectedDevice.id} · firmware {selectedDevice.firmwareVersion}
                  </p>
                </div>
                <div className={styles.detailBadges}>
                  <span className={styles.healthBadge} data-health={selectedDevice.healthStatus}>
                    {selectedDevice.healthStatus}
                  </span>
                  <span className={styles.detailChip}>
                    fw {selectedDevice.firmwareVersion}
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
                  <span>Site ID</span>
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
                  <span className={styles.telemetryLabel}>Boot ID</span>
                  <strong>{selectedDevice.bootId ?? "unknown"}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Heartbeat</span>
                  <strong>{formatLocalTime(selectedDevice.lastHeartbeatAt)}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Last event</span>
                  <strong>{formatLocalTime(selectedDevice.lastEventReceivedAt)}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Provisioning</span>
                  <strong>{selectedDevice.provisioningState}</strong>
                </div>
                <div>
                  <span className={styles.telemetryLabel}>Update status</span>
                  <strong>{selectedDevice.updateStatus}</strong>
                </div>
              </div>

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
              <h2 className={styles.panelTitle}>Choose a sensor or start provisioning</h2>
              <p className={styles.panelCopy}>
                Pick a device from the roster to edit its labels, or add a new sensor
                to launch the Bluetooth setup flow.
              </p>
              <button
                className={styles.primaryButton}
                onClick={() => setShowProvisioningWizard(true)}
                type="button"
              >
                Add device
              </button>
            </section>
          )}
        </div>
      </div>
    </AppShell>
  );
}
