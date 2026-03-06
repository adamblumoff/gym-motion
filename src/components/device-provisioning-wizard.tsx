"use client";

import { useEffect, useMemo, useState } from "react";

import type { DeviceSummary, MotionStreamPayload } from "@/lib/motion";
import type {
  ProvisioningStatusMessage,
  StoredWiFiProfile,
} from "@/lib/provisioning";
import {
  bluetoothSupported,
  clearStoredWiFiProfile,
  connectProvisioningDevice,
  loadStoredWiFiProfile,
  requestProvisioningDevice,
  sendProvisioningCommand,
  storeWiFiProfile,
  subscribeToProvisioningStatus,
} from "@/lib/provisioning";

import styles from "./device-provisioning-wizard.module.css";

type DeviceResponse = {
  device: DeviceSummary;
};

type Props = {
  mode: "first-device" | "add-device";
  onCancel?: () => void;
  onComplete?: (device: DeviceSummary) => void;
};

type Step = "connect" | "network" | "details" | "provisioning" | "done";

function uniqueNetworkList(networks: string[]) {
  return Array.from(new Set(networks.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function DeviceProvisioningWizard({
  mode,
  onCancel,
  onComplete,
}: Props) {
  const [step, setStep] = useState<Step>("connect");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hardwareId, setHardwareId] = useState("");
  const [firmwareVersion, setFirmwareVersion] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [bluetoothConnected, setBluetoothConnected] = useState(false);
  const [controlCharacteristic, setControlCharacteristic] =
    useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [networks, setNetworks] = useState<string[]>([]);
  const [selectedSsid, setSelectedSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [machineLabel, setMachineLabel] = useState("");
  const [siteId, setSiteId] = useState("");
  const [rememberWifi, setRememberWifi] = useState(true);
  const [pendingProvisionDeviceId, setPendingProvisionDeviceId] = useState<
    string | null
  >(null);
  const [completedDevice, setCompletedDevice] = useState<DeviceSummary | null>(null);
  const [storedProfile, setStoredProfile] = useState<StoredWiFiProfile | null>(
    null,
  );

  useEffect(() => {
    setStoredProfile(loadStoredWiFiProfile());
  }, []);

  useEffect(() => {
    if (!storedProfile) {
      return;
    }

    if (!siteId) {
      setSiteId(storedProfile.siteId);
    }

    if (!wifiPassword) {
      setWifiPassword(storedProfile.password);
    }
  }, [siteId, storedProfile, wifiPassword]);

  useEffect(() => {
    if (!storedProfile) {
      return;
    }

    if (networks.includes(storedProfile.ssid) && !selectedSsid) {
      setSelectedSsid(storedProfile.ssid);
    }
  }, [networks, selectedSsid, storedProfile]);

  useEffect(() => {
    const eventSource = new EventSource("/api/stream");

    eventSource.addEventListener("motion-update", (rawEvent) => {
      if (!pendingProvisionDeviceId) {
        return;
      }

      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as MotionStreamPayload;

      if (
        payload.device.id === pendingProvisionDeviceId &&
        payload.device.provisioningState === "provisioned"
      ) {
        setCompletedDevice(payload.device);
        setStep("done");
        setStatus(`${payload.device.id} is online and provisioned.`);
      }
    });

    return () => {
      eventSource.close();
    };
  }, [onComplete, pendingProvisionDeviceId]);

  const networkChoices = useMemo(() => uniqueNetworkList(networks), [networks]);

  async function handleProvisioningMessage(message: ProvisioningStatusMessage) {
    switch (message.type) {
      case "ready":
        setHardwareId(message.hardwareId);
        setFirmwareVersion(message.firmwareVersion);
        setDeviceName(message.deviceName);
        setStatus("Device connected. Scanning nearby networks…");
        setStep("network");
        break;
      case "scan-result":
        setNetworks((current) => uniqueNetworkList([...current, message.ssid]));
        break;
      case "scan-complete":
        setStatus("Choose the gym Wi-Fi and continue.");
        break;
      case "phase":
        setStatus(message.message);
        break;
      case "provisioned":
        setPendingProvisionDeviceId(message.deviceId);
        setStep("provisioning");
        setStatus(
          `${message.deviceId} saved its Wi-Fi settings. Waiting for it to appear online…`,
        );
        break;
      case "error":
        setError(message.message);
        break;
    }
  }

  async function handleConnect() {
    try {
      setError(null);
      setStatus("Opening the Bluetooth chooser…");
      const device = await requestProvisioningDevice();
      const connection = await connectProvisioningDevice(device);
      const cleanup = subscribeToProvisioningStatus(
        connection.status,
        (message) => {
          void handleProvisioningMessage(message);
        },
      );

      device.addEventListener(
        "gattserverdisconnected",
        () => {
          cleanup();
          setBluetoothConnected(false);
          setControlCharacteristic(null);
          setStatus("Bluetooth disconnected. Reconnect to continue.");
        },
        { once: true },
      );

      setBluetoothConnected(true);
      setControlCharacteristic(connection.control);
      setStatus("Connected over Bluetooth. Asking the device to scan Wi-Fi…");

      await sendProvisioningCommand(connection.control, {
        type: "scan",
      });
    } catch (nextError) {
      console.error(nextError);
      setError("Could not connect to the device over Bluetooth.");
      setStatus(null);
    }
  }

  async function handleContinueToDetails() {
    if (!selectedSsid || !wifiPassword) {
      setError("Choose a Wi-Fi network and enter its password.");
      return;
    }

    setError(null);
    setStep("details");
  }

  async function handleProvision() {
    if (!controlCharacteristic) {
      setError("Bluetooth is not connected.");
      return;
    }

    if (!deviceId || !siteId) {
      setError("Device ID and site ID are required.");
      return;
    }

    setError(null);
    setStep("provisioning");
    setStatus("Registering the device in the app and sending Wi-Fi settings…");

    try {
      const response = await fetch("/api/devices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId,
          machineLabel: machineLabel || null,
          siteId,
          hardwareId: hardwareId || null,
          provisioningState: "assigned",
        }),
      });

      if (!response.ok) {
        throw new Error("Could not register the device.");
      }

      const data = (await response.json()) as DeviceResponse;
      void data;

      if (rememberWifi) {
        storeWiFiProfile({
          ssid: selectedSsid,
          password: wifiPassword,
          siteId,
        });
        setStoredProfile({
          ssid: selectedSsid,
          password: wifiPassword,
          siteId,
        });
      }

      await sendProvisioningCommand(controlCharacteristic, {
        type: "provision",
        deviceId,
        siteId,
        wifiSsid: selectedSsid,
        wifiPassword,
      });

      setPendingProvisionDeviceId(deviceId);
      setStatus("Waiting for the device to join Wi-Fi and report online…");
    } catch (nextError) {
      console.error(nextError);
      setError("Provisioning failed before the device finished setup.");
      setStep("details");
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>
            {mode === "first-device" ? "First install" : "Add device"}
          </div>
          <h2 className={styles.title}>
            {mode === "first-device"
              ? "Set up your first Gym Motion sensor"
              : "Pair another device over Bluetooth"}
          </h2>
        </div>
        <div className={styles.badges}>
          <span className={styles.badge} data-state={bluetoothConnected ? "live" : "idle"}>
            {bluetoothConnected ? "BLE connected" : "Chrome / Edge only"}
          </span>
          {storedProfile ? (
            <span className={styles.badge}>Saved Wi-Fi ready</span>
          ) : null}
        </div>
      </div>

      <div className={styles.steps}>
        <span data-active={step === "connect"}>1. Connect</span>
        <span data-active={step === "network"}>2. Network</span>
        <span data-active={step === "details"}>3. Details</span>
        <span data-active={step === "provisioning" || step === "done"}>
          4. Provision
        </span>
      </div>

      {status ? <p className={styles.status}>{status}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}

      {step === "connect" ? (
        <div className={styles.panel}>
          <p className={styles.copy}>
            This setup flow uses Web Bluetooth, so the installer needs Chrome or
            Edge over HTTPS. Click once to pick the unconfigured device from the
            Bluetooth chooser.
          </p>
          <div className={styles.actions}>
            <button
              className={styles.primaryButton}
              disabled={!bluetoothSupported()}
              onClick={() => void handleConnect()}
              type="button"
            >
              Connect device
            </button>
            {onCancel ? (
              <button className={styles.secondaryButton} onClick={onCancel} type="button">
                Cancel
              </button>
            ) : null}
          </div>
          {!bluetoothSupported() ? (
            <p className={styles.hint}>
              Web Bluetooth is not available in this browser. Use Chrome or Edge.
            </p>
          ) : null}
        </div>
      ) : null}

      {step === "network" ? (
        <div className={styles.panel}>
          <div className={styles.summaryGrid}>
            <div>
              <span className={styles.summaryLabel}>Device</span>
              <strong>{deviceName || "Bluetooth device connected"}</strong>
            </div>
            <div>
              <span className={styles.summaryLabel}>Hardware ID</span>
              <strong>{hardwareId || "Waiting…"}</strong>
            </div>
            <div>
              <span className={styles.summaryLabel}>Firmware</span>
              <strong>{firmwareVersion || "0.4.3"}</strong>
            </div>
          </div>

          <label className={styles.field}>
            <span>Gym Wi-Fi</span>
            <select
              onChange={(event) => setSelectedSsid(event.target.value)}
              value={selectedSsid}
            >
              <option value="">Select a network</option>
              {networkChoices.map((network) => (
                <option key={network} value={network}>
                  {network}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>Password</span>
            <input
              onChange={(event) => setWifiPassword(event.target.value)}
              type="password"
              value={wifiPassword}
            />
          </label>

          <label className={styles.toggle}>
            <input
              checked={rememberWifi}
              onChange={(event) => setRememberWifi(event.target.checked)}
              type="checkbox"
            />
            <span>Remember this Wi-Fi on this installer computer</span>
          </label>

          <div className={styles.actions}>
            <button className={styles.primaryButton} onClick={() => void handleContinueToDetails()} type="button">
              Continue
            </button>
            {storedProfile ? (
              <button
                className={styles.secondaryButton}
                onClick={() => {
                  clearStoredWiFiProfile();
                  setStoredProfile(null);
                }}
                type="button"
              >
                Clear saved Wi-Fi
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === "details" ? (
        <div className={styles.panel}>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>Device ID</span>
              <input
                onChange={(event) => setDeviceId(event.target.value)}
                placeholder="stack-001"
                value={deviceId}
              />
            </label>
            <label className={styles.field}>
              <span>Machine label</span>
              <input
                onChange={(event) => setMachineLabel(event.target.value)}
                placeholder="Leg Press 2"
                value={machineLabel}
              />
            </label>
            <label className={styles.field}>
              <span>Site ID</span>
              <input
                onChange={(event) => setSiteId(event.target.value)}
                placeholder="gym-dallas"
                value={siteId}
              />
            </label>
            <label className={styles.field}>
              <span>Hardware ID</span>
              <input readOnly value={hardwareId} />
            </label>
          </div>

          <div className={styles.actions}>
            <button className={styles.primaryButton} onClick={() => void handleProvision()} type="button">
              Save and provision
            </button>
            <button className={styles.secondaryButton} onClick={() => setStep("network")} type="button">
              Back
            </button>
          </div>
        </div>
      ) : null}

      {step === "provisioning" ? (
        <div className={styles.panel}>
          <p className={styles.copy}>
            The browser has handed Wi-Fi settings to the device over Bluetooth.
            Now we are waiting for it to restart, join the network, and show up in
            the app as a provisioned device.
          </p>
          <div className={styles.waitingPulse} />
        </div>
      ) : null}

      {step === "done" ? (
        <div className={styles.panel}>
          <p className={styles.copy}>
            The device is online. It should now appear in the live dashboard, logs,
            and OTA rollout controls like every other provisioned sensor.
          </p>
          <div className={styles.actions}>
            {onComplete ? (
              <button
                className={styles.primaryButton}
                onClick={() => {
                  if (completedDevice) {
                    onComplete(completedDevice);
                  }
                }}
                type="button"
              >
                Finish
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
