export const PROVISIONING_SERVICE_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c201";
export const PROVISIONING_CONTROL_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c202";
export const PROVISIONING_STATUS_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c203";

export const LOCAL_WIFI_PROFILE_KEY = "gym-motion.local-wifi-profile";

export type ProvisioningStatusMessage =
  | {
      type: "ready";
      hardwareId: string;
      firmwareVersion: string;
      deviceName: string;
    }
  | {
      type: "scan-result";
      ssid: string;
      rssi?: number;
    }
  | {
      type: "scan-complete";
    }
  | {
      type: "phase";
      phase:
        | "ble-connected"
        | "scanning"
        | "saving"
        | "wifi-connecting"
        | "restarting";
      message: string;
    }
  | {
      type: "provisioned";
      deviceId: string;
      siteId: string | null;
    }
  | {
      type: "error";
      message: string;
    };

export type ProvisioningCommand =
  | {
      type: "scan";
    }
  | {
      type: "provision";
      deviceId: string;
      siteId: string | null;
      wifiSsid: string;
      wifiPassword: string;
    };

export type StoredWiFiProfile = {
  ssid: string;
  password: string;
  siteId: string;
};

export function bluetoothSupported() {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export function loadStoredWiFiProfile(): StoredWiFiProfile | null {
  if (typeof window === "undefined") {
    return null;
  }

  const value = window.localStorage.getItem(LOCAL_WIFI_PROFILE_KEY);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as StoredWiFiProfile;
  } catch {
    return null;
  }
}

export function storeWiFiProfile(profile: StoredWiFiProfile) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(LOCAL_WIFI_PROFILE_KEY, JSON.stringify(profile));
}

export function clearStoredWiFiProfile() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LOCAL_WIFI_PROFILE_KEY);
}

function encodeValue(input: string) {
  return new TextEncoder().encode(input);
}

function decodeValue(value: DataView) {
  return new TextDecoder().decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export async function requestProvisioningDevice() {
  return navigator.bluetooth.requestDevice({
    filters: [
      {
        services: [PROVISIONING_SERVICE_UUID],
      },
    ],
    optionalServices: [PROVISIONING_SERVICE_UUID],
  });
}

export async function connectProvisioningDevice(device: BluetoothDevice) {
  const server = await device.gatt?.connect();

  if (!server) {
    throw new Error("Could not connect to the Bluetooth device.");
  }

  const service = await server.getPrimaryService(PROVISIONING_SERVICE_UUID);
  const control = await service.getCharacteristic(PROVISIONING_CONTROL_UUID);
  const status = await service.getCharacteristic(PROVISIONING_STATUS_UUID);

  await status.startNotifications();

  return {
    server,
    control,
    status,
  };
}

export async function sendProvisioningCommand(
  characteristic: BluetoothRemoteGATTCharacteristic,
  command: ProvisioningCommand,
) {
  const payload = JSON.stringify(command);
  const chunkSize = 120;

  await characteristic.writeValueWithResponse(encodeValue(`BEGIN:${payload.length}`));

  for (let index = 0; index < payload.length; index += chunkSize) {
    await characteristic.writeValueWithResponse(
      encodeValue(payload.slice(index, index + chunkSize)),
    );
  }

  await characteristic.writeValueWithResponse(encodeValue("END"));
}

export function subscribeToProvisioningStatus(
  characteristic: BluetoothRemoteGATTCharacteristic,
  onMessage: (message: ProvisioningStatusMessage) => void,
) {
  const listener = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic | null;

    if (!target?.value) {
      return;
    }

    try {
      const message = JSON.parse(
        decodeValue(target.value),
      ) as ProvisioningStatusMessage;
      onMessage(message);
    } catch {}
  };

  characteristic.addEventListener(
    "characteristicvaluechanged",
    listener as EventListener,
  );

  return () => {
    characteristic.removeEventListener(
      "characteristicvaluechanged",
      listener as EventListener,
    );
  };
}
