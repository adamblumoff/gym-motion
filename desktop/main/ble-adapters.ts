import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type { BleAdapterSummary } from "@core/contracts";

const require = createRequire(import.meta.url);

type UsbDeviceListEntry = {
  idVendor: number;
  idProduct: number;
  busNumber: number;
  deviceAddress: number;
};

function formatHex(value: number) {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function fingerprintUsbDevice(device: UsbDeviceListEntry) {
  return [
    "usb",
    formatHex(device.idVendor),
    formatHex(device.idProduct),
    String(device.busNumber),
    String(device.deviceAddress),
  ].join(":");
}

function readTextFile(filePath: string) {
  try {
    return readFileSync(filePath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function listLinuxAdapters(): BleAdapterSummary[] {
  const basePath = "/sys/class/bluetooth";
  const entries = readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^hci\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  return entries.map((name) => {
    const numericId = Number(name.replace("hci", ""));
    const address = readTextFile(path.join(basePath, name, "address"));
    const modalias = readTextFile(path.join(basePath, name, "device", "modalias"));
    const label = address ? `${name.toUpperCase()} · ${address}` : name.toUpperCase();

    return {
      id: `hci:${numericId}`,
      label,
      transport: "hci",
      runtimeDeviceId: numericId,
      isAvailable: true,
      issue: null,
      details: modalias ? [modalias] : [],
    };
  });
}

function listUsbAdapters(): BleAdapterSummary[] {
  const module = require("@abandonware/bluetooth-hci-socket") as
    | { default?: new () => { getDeviceList?: () => UsbDeviceListEntry[] } }
    | (new () => { getDeviceList?: () => UsbDeviceListEntry[] });
  const BluetoothHciSocket = ("default" in module ? module.default : module) as {
    new (): { getDeviceList?: () => UsbDeviceListEntry[] };
  };
  const socket = new BluetoothHciSocket();
  const devices = socket.getDeviceList?.() ?? [];

  return devices.map((device, index) => ({
    id: fingerprintUsbDevice(device),
    label: `USB adapter ${index + 1}`,
    transport: "usb",
    runtimeDeviceId: index + 1,
    isAvailable: true,
    issue: null,
    details: [
      `VID ${formatHex(device.idVendor)}`,
      `PID ${formatHex(device.idProduct)}`,
      `BUS ${device.busNumber}`,
      `ADDR ${device.deviceAddress}`,
    ],
  }));
}

export async function listBleAdapters(): Promise<BleAdapterSummary[]> {
  try {
    if (process.platform === "win32") {
      return listUsbAdapters();
    }

    if (process.platform === "linux") {
      return listLinuxAdapters();
    }
  } catch (error) {
    return [
      {
        id: "adapter-error",
        label: "Bluetooth adapter detection failed",
        transport: "unknown",
        runtimeDeviceId: null,
        isAvailable: false,
        issue: error instanceof Error ? error.message : "Adapter detection failed.",
        details: [],
      },
    ];
  }

  return [];
}
