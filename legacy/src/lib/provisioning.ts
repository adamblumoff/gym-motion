export const PROVISIONING_SERVICE_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c201";
export const PROVISIONING_CONTROL_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c202";
export const PROVISIONING_STATUS_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c203";

export type ProvisioningStatusMessage =
  | {
      type: "ready";
      hardwareId: string;
      firmwareVersion: string;
      deviceName: string;
    }
  | {
      type: "phase";
      phase: "ble-connected" | "saving";
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
  {
    type: "provision";
    deviceId: string;
    siteId: string | null;
    machineLabel: string | null;
  };

export function bluetoothSupported() {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

function encodeValue(input: string) {
  return new TextEncoder().encode(input);
}

function decodeValue(value: DataView) {
  return new TextDecoder().decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

function tryParseStatusMessage(value: DataView) {
  try {
    return JSON.parse(decodeValue(value)) as ProvisioningStatusMessage;
  } catch {
    return null;
  }
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

export async function readProvisioningStatus(
  characteristic: BluetoothRemoteGATTCharacteristic,
) {
  const value = await characteristic.readValue();
  return tryParseStatusMessage(value);
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
      const message = tryParseStatusMessage(target.value);

      if (message) {
        onMessage(message);
      }
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
