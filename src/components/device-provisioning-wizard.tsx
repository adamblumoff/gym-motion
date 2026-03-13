"use client";

import { useState } from "react";

import type { DeviceSummary } from "@/lib/motion";
import type { ProvisioningStatusMessage } from "@/lib/provisioning";
import {
  bluetoothSupported,
  connectProvisioningDevice,
  readProvisioningStatus,
  requestProvisioningDevice,
  sendProvisioningCommand,
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

type Step = "connect" | "bluetooth" | "details" | "provisioning" | "done";

function looksLikeUserDismissedBluetoothDialog(error: unknown) {
  if (!(error instanceof DOMException)) {
    return false;
  }

  return error.name === "NotFoundError" || error.name === "NotAllowedError";
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
  const [deviceId, setDeviceId] = useState("");
  const [machineLabel, setMachineLabel] = useState("");
  const [siteId, setSiteId] = useState("");
  const [bluetoothConnected, setBluetoothConnected] = useState(false);
  const [controlCharacteristic, setControlCharacteristic] =
    useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [completedDevice, setCompletedDevice] = useState<DeviceSummary | null>(null);

  function handleProvisioningMessage(message: ProvisioningStatusMessage) {
    switch (message.type) {
      case "ready":
        setHardwareId(message.hardwareId);
        setFirmwareVersion(message.firmwareVersion);
        setDeviceName(message.deviceName);
        setDeviceId((currentDeviceId) => currentDeviceId || message.hardwareId);
        setStatus("Bluetooth connected. Add the device metadata and save.");
        setStep("details");
        break;
      case "phase":
        setStatus(message.message);
        break;
      case "provisioned":
        setStatus(`${message.deviceId} saved its Bluetooth gateway identity.`);
        break;
      case "error":
        setError(message.message);
        setStep("details");
        break;
    }
  }

  async function handleConnect() {
    try {
      setError(null);
      setStep("bluetooth");
      setStatus("Opening the Bluetooth chooser…");
      const device = await requestProvisioningDevice();
      const connection = await connectProvisioningDevice(device);
      const initialStatus = await readProvisioningStatus(connection.status);

      const cleanup = subscribeToProvisioningStatus(connection.status, handleProvisioningMessage);

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
      setStatus("Connected over Bluetooth. Waiting for device identity…");

      if (initialStatus) {
        handleProvisioningMessage(initialStatus);
      }
    } catch (nextError) {
      if (looksLikeUserDismissedBluetoothDialog(nextError)) {
        setStep("connect");
        setStatus("Bluetooth chooser closed. Connect again when you are ready.");
        return;
      }

      console.error(nextError);
      setError("Could not connect to the device over Bluetooth.");
      setStep("connect");
      setStatus(null);
    }
  }

  async function handleProvision() {
    if (!controlCharacteristic) {
      setError("Bluetooth is not connected.");
      return;
    }

    if (!deviceId || !siteId) {
      setError("Device ID and zone are required.");
      return;
    }

    setError(null);
    setStep("provisioning");
    setStatus("Registering the device in the app and saving its BLE identity…");

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

      await sendProvisioningCommand(controlCharacteristic, {
        type: "provision",
        deviceId,
        siteId,
        machineLabel: machineLabel || null,
      });

      setCompletedDevice(data.device);
      setStep("done");
      setStatus(`${deviceId} is ready for the BLE gateway.`);
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
              ? "Set up your first BLE Gym Motion sensor"
              : "Pair another BLE node"}
          </h2>
        </div>
        <div className={styles.badges}>
          <span className={styles.badge} data-state={bluetoothConnected ? "live" : "idle"}>
            {bluetoothConnected ? "BLE connected" : "Chrome / Edge only"}
          </span>
        </div>
      </div>

      <div className={styles.steps}>
        <span data-active={step === "connect"}>1. Connect</span>
        <span data-active={step === "bluetooth"}>2. Bluetooth</span>
        <span data-active={step === "details"}>3. Details</span>
        <span data-active={step === "provisioning" || step === "done"}>
          4. Save
        </span>
      </div>

      {status ? <p className={styles.status}>{status}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}

      {step === "connect" ? (
        <div className={styles.panel}>
          <p className={styles.copy}>
            This setup flow uses Web Bluetooth, so the installer needs Chrome or
            Edge over HTTPS. Pick the node from the Bluetooth chooser, then save
            the device ID and zone metadata the gateway will use later.
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

      {step === "bluetooth" ? (
        <div className={styles.panel}>
          <p className={styles.copy}>
            We are connecting to the sensor over Bluetooth and waiting for its
            identity packet. This usually takes a second or two.
          </p>
          <div className={styles.waitingPulse} />
          <div className={styles.actions}>
            <button
              className={styles.secondaryButton}
              onClick={() => {
                setStep("connect");
                setStatus("Reconnect when you are ready.");
              }}
              type="button"
            >
              Back
            </button>
            {onCancel ? (
              <button className={styles.secondaryButton} onClick={onCancel} type="button">
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === "details" ? (
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
              <strong>{firmwareVersion || "unknown"}</strong>
            </div>
          </div>

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
              <span>Zone</span>
              <input
                onChange={(event) => setSiteId(event.target.value)}
                placeholder="weight-floor-a"
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
              Save device
            </button>
            <button
              className={styles.secondaryButton}
              onClick={() => {
                setStep("connect");
                setStatus("Reconnect when you are ready.");
              }}
              type="button"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {step === "provisioning" ? (
        <div className={styles.panel}>
          <p className={styles.copy}>
            The browser is saving device metadata over Bluetooth. Once this
            finishes, the node is ready for the laptop gateway to discover it and
            forward motion updates to the backend.
          </p>
          <div className={styles.waitingPulse} />
        </div>
      ) : null}

      {step === "done" ? (
        <div className={styles.panel}>
          <p className={styles.copy}>
            The device metadata is saved. Start the BLE gateway and the node will
            appear in the live dashboard as soon as the gateway receives motion or
            keepalive packets.
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
