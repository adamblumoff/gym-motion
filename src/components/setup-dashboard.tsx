"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

import type {
  DeviceSummary,
  FirmwareReleaseSummary,
  MotionStreamPayload,
} from "@/lib/motion";
import { mergeDeviceUpdate } from "@/lib/motion";

import styles from "./setup-dashboard.module.css";
import { DeviceProvisioningWizard } from "./device-provisioning-wizard";

type DevicesResponse = {
  devices: DeviceSummary[];
};

type ReleasesResponse = {
  releases: FirmwareReleaseSummary[];
};

type Drafts = Record<
  string,
  {
    machineLabel: string;
    siteId: string;
    hardwareId: string;
    provisioningState: DeviceSummary["provisioningState"];
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
        provisioningState: device.provisioningState,
      },
    ]),
  );
}

function formatTime(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function SetupDashboard() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [releases, setReleases] = useState<FirmwareReleaseSummary[]>([]);
  const [releaseForm, setReleaseForm] = useState({
    version: "",
    gitSha: "",
    assetUrl: "",
    sha256: "",
    md5: "",
    sizeBytes: "",
    rolloutState: "draft",
  });
  const [status, setStatus] = useState<string | null>(null);
  const [showProvisioningWizard, setShowProvisioningWizard] = useState(false);

  const activeRelease =
    releases.find((release) => release.rolloutState === "active") ?? null;

  useEffect(() => {
    let cancelled = false;
    const eventSource = new EventSource("/api/stream");

    async function loadData() {
      const [devicesResponse, releasesResponse] = await Promise.all([
        fetch("/api/devices", { cache: "no-store" }),
        fetch("/api/firmware/releases", { cache: "no-store" }),
      ]);

      if (!devicesResponse.ok || !releasesResponse.ok) {
        throw new Error("Failed to load setup data.");
      }

      const deviceData = (await devicesResponse.json()) as DevicesResponse;
      const releaseData = (await releasesResponse.json()) as ReleasesResponse;

      if (!cancelled) {
        setDevices(deviceData.devices);
        setDrafts(createDrafts(deviceData.devices));
        setReleases(releaseData.releases);
      }
    }

    eventSource.addEventListener("motion-update", (rawEvent) => {
      if (cancelled) {
        return;
      }

      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as MotionStreamPayload;

      setDevices((currentDevices) => mergeDeviceUpdate(currentDevices, payload.device));
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [payload.device.id]: currentDrafts[payload.device.id] ?? {
          machineLabel: payload.device.machineLabel ?? "",
          siteId: payload.device.siteId ?? "",
          hardwareId: payload.device.hardwareId ?? "",
          provisioningState: payload.device.provisioningState,
        },
      }));
    });

    void loadData().catch(() => {
      if (!cancelled) {
        setStatus("Could not load setup data.");
      }
    });

    return () => {
      cancelled = true;
      eventSource.close();
    };
  }, []);

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
        provisioningState: draft.provisioningState,
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
      `Delete ${deviceId} from the app? After deletion, hold the ESP32 BOOT button while tapping EN (reset) so the sensor clears saved Wi-Fi and re-enters BLE setup mode.`,
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

    let remainingDeviceCount = 0;
    setDevices((currentDevices) => {
      const nextDevices = currentDevices.filter((device) => device.id !== deviceId);
      remainingDeviceCount = nextDevices.length;
      return nextDevices;
    });
    setDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      delete nextDrafts[deviceId];
      return nextDrafts;
    });
    if (remainingDeviceCount === 0) {
      setShowProvisioningWizard(true);
    }
    setStatus(
      `Deleted ${deviceId}. To provision the same sensor again, hold BOOT on the ESP32 while tapping EN so it clears saved Wi-Fi and re-enters BLE setup mode.`,
    );
  }

  async function handleReleaseSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const response = await fetch("/api/firmware/releases", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...releaseForm,
        sizeBytes: Number(releaseForm.sizeBytes),
      }),
    });

    if (!response.ok) {
      setStatus("Failed to save firmware release.");
      return;
    }

    const data = (await response.json()) as { release: FirmwareReleaseSummary };

    setReleases((currentReleases) => [data.release, ...currentReleases]);
        setReleaseForm({
          version: "",
          gitSha: "",
          assetUrl: "",
          sha256: "",
          md5: "",
          sizeBytes: "",
          rolloutState: "draft",
        });
    setStatus(`Saved firmware ${data.release.version}.`);
  }

  return (
    <section className={styles.page}>
      <div className={styles.shell}>
        <nav className={styles.topBar}>
          <div>
            <div className={styles.eyebrow}>Ops dashboard</div>
            <h1 className={styles.title}>Device health and rollout control</h1>
          </div>
          <div className={styles.topLinks}>
            <Link className={styles.topLink} href="/logs">
              Logs
            </Link>
            <Link className={styles.topLink} href="/">
              Back to live board
            </Link>
          </div>
        </nav>

        {status ? <p className={styles.status}>{status}</p> : null}

        {showProvisioningWizard ? (
          <DeviceProvisioningWizard
            mode="add-device"
            onCancel={() => setShowProvisioningWizard(false)}
            onComplete={() => {
              setShowProvisioningWizard(false);
              setStatus("Device provisioned successfully.");
            }}
          />
        ) : null}

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2>Devices</h2>
            <p>
              This page is for labeling devices, watching fleet health, and seeing
              which devices are behind the active firmware release.
            </p>
          </div>

          <div className={styles.rolloutBanner}>
            <span className={styles.rolloutLabel}>Add device</span>
            <strong>BLE provisioning</strong>
            <span className={styles.rolloutHint}>
              Pair a fresh sensor over Bluetooth, send it the remembered gym Wi-Fi,
              and wait for it to appear online automatically.
            </span>
            <button
              className={styles.saveButton}
              onClick={() => setShowProvisioningWizard(true)}
              type="button"
            >
              Add device
            </button>
          </div>

          <div className={styles.rolloutBanner}>
            <span className={styles.rolloutLabel}>Re-provision</span>
            <strong>Delete + BOOT/EN reset</strong>
            <span className={styles.rolloutHint}>
              Deleting a device only forgets it in the app. To run setup again on the
              same ESP32, hold <strong>BOOT</strong> and tap <strong>EN</strong> so it
              clears saved Wi-Fi and comes back in BLE setup mode.
            </span>
          </div>

          <div className={styles.rolloutBanner}>
            <span className={styles.rolloutLabel}>Active release</span>
            <strong>{activeRelease?.version ?? "None"}</strong>
            <span className={styles.rolloutHint}>
              {activeRelease
                ? "Devices that report an older version should pull the update on their next check-in."
                : "No active release is published yet."}
            </span>
          </div>

          <div className={styles.deviceList}>
            {devices.length === 0 ? (
              <div className={styles.emptyCard}>No devices have checked in yet.</div>
            ) : (
              devices.map((device) => {
                const draft = drafts[device.id] ?? {
                  machineLabel: device.machineLabel ?? "",
                  siteId: device.siteId ?? "",
                  hardwareId: device.hardwareId ?? "",
                  provisioningState: device.provisioningState,
                };

                return (
                  <article className={styles.deviceCard} key={device.id}>
                    <div className={styles.deviceHeader}>
                      <div>
                        <strong>{device.machineLabel ?? device.id}</strong>
                        <div className={styles.deviceSubline}>
                          {device.id} · {device.healthStatus.toUpperCase()} · firmware{" "}
                          {device.firmwareVersion}
                        </div>
                      </div>
                      <div className={styles.deviceActions}>
                        <span
                          className={styles.rolloutBadge}
                          data-state={
                            activeRelease && activeRelease.version !== device.firmwareVersion
                              ? "behind"
                              : "current"
                          }
                        >
                          {activeRelease && activeRelease.version !== device.firmwareVersion
                            ? `Behind ${activeRelease.version}`
                            : "Up to date"}
                        </span>
                      <button
                        className={styles.saveButton}
                        onClick={() => void handleDeviceSave(device.id)}
                        type="button"
                      >
                        Save
                      </button>
                      <button
                        className={styles.saveButton}
                        data-variant="danger"
                        onClick={() => void handleDeviceDelete(device.id)}
                        type="button"
                      >
                        Delete
                      </button>
                      </div>
                    </div>

                    <div className={styles.formGrid}>
                      <label className={styles.field}>
                        <span>Machine label</span>
                        <input
                          value={draft.machineLabel}
                          onChange={(inputEvent) =>
                            setDrafts((currentDrafts) => ({
                              ...currentDrafts,
                              [device.id]: {
                                ...draft,
                                machineLabel: inputEvent.target.value,
                              },
                            }))
                          }
                        />
                      </label>

                      <label className={styles.field}>
                        <span>Site ID</span>
                        <input
                          value={draft.siteId}
                          onChange={(inputEvent) =>
                            setDrafts((currentDrafts) => ({
                              ...currentDrafts,
                              [device.id]: {
                                ...draft,
                                siteId: inputEvent.target.value,
                              },
                            }))
                          }
                        />
                      </label>

                      <label className={styles.field}>
                        <span>Hardware ID</span>
                        <input
                          value={draft.hardwareId}
                          onChange={(inputEvent) =>
                            setDrafts((currentDrafts) => ({
                              ...currentDrafts,
                              [device.id]: {
                                ...draft,
                                hardwareId: inputEvent.target.value,
                              },
                            }))
                          }
                        />
                      </label>

                      <label className={styles.field}>
                        <span>Provisioning state</span>
                        <select
                          value={draft.provisioningState}
                          onChange={(inputEvent) =>
                            setDrafts((currentDrafts) => ({
                              ...currentDrafts,
                              [device.id]: {
                                ...draft,
                                provisioningState:
                                  inputEvent.target.value as DeviceSummary["provisioningState"],
                              },
                            }))
                          }
                        >
                          <option value="unassigned">unassigned</option>
                          <option value="assigned">assigned</option>
                          <option value="provisioned">provisioned</option>
                        </select>
                      </label>
                    </div>

                    <div className={styles.deviceMeta}>
                      <span>Boot ID {device.bootId ?? "unknown"}</span>
                      <span>Heartbeat {formatTime(device.lastHeartbeatAt)}</span>
                      <span>Last event {formatTime(device.lastEventReceivedAt)}</span>
                      <span>Update status {device.updateStatus}</span>
                      <span>
                        Target firmware {activeRelease?.version ?? "none"}
                      </span>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2>Firmware releases</h2>
            <p>
              Store the GitHub release metadata the OTA check endpoint serves back
              to devices. Leave a release active until all devices catch up.
            </p>
          </div>

          <form className={styles.releaseForm} onSubmit={(event) => void handleReleaseSubmit(event)}>
            <label className={styles.field}>
              <span>Version</span>
              <input
                required
                value={releaseForm.version}
                onChange={(event) =>
                  setReleaseForm((currentForm) => ({
                    ...currentForm,
                    version: event.target.value,
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              <span>Git SHA</span>
              <input
                required
                value={releaseForm.gitSha}
                onChange={(event) =>
                  setReleaseForm((currentForm) => ({
                    ...currentForm,
                    gitSha: event.target.value,
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              <span>Asset URL or object key</span>
              <input
                required
                value={releaseForm.assetUrl}
                onChange={(event) =>
                  setReleaseForm((currentForm) => ({
                    ...currentForm,
                    assetUrl: event.target.value,
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              <span>SHA-256</span>
              <input
                required
                value={releaseForm.sha256}
                onChange={(event) =>
                  setReleaseForm((currentForm) => ({
                    ...currentForm,
                    sha256: event.target.value,
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              <span>MD5</span>
              <input
                value={releaseForm.md5}
                onChange={(event) =>
                  setReleaseForm((currentForm) => ({
                    ...currentForm,
                    md5: event.target.value,
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              <span>Size in bytes</span>
              <input
                required
                inputMode="numeric"
                value={releaseForm.sizeBytes}
                onChange={(event) =>
                  setReleaseForm((currentForm) => ({
                    ...currentForm,
                    sizeBytes: event.target.value,
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              <span>Rollout state</span>
              <select
                value={releaseForm.rolloutState}
                onChange={(event) =>
                  setReleaseForm((currentForm) => ({
                    ...currentForm,
                    rolloutState: event.target.value,
                  }))
                }
              >
                <option value="draft">draft</option>
                <option value="active">active</option>
                <option value="paused">paused</option>
              </select>
            </label>
            <button className={styles.saveButton} type="submit">
              Save release
            </button>
          </form>

          <div className={styles.releaseList}>
            {releases.length === 0 ? (
              <div className={styles.emptyCard}>No firmware releases stored yet.</div>
            ) : (
              releases.map((release) => (
                <article className={styles.releaseCard} key={release.version}>
                  <strong>{release.version}</strong>
                  <div>{release.rolloutState}</div>
                  <div>{release.gitSha}</div>
                  <div>{formatTime(release.createdAt)}</div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
