declare interface RequestDeviceOptions {
  filters?: Array<{
    services?: BluetoothServiceUUID[];
    namePrefix?: string;
  }>;
  optionalServices?: BluetoothServiceUUID[];
  acceptAllDevices?: boolean;
}

declare type BluetoothServiceUUID = string | number;

declare interface Bluetooth {
  requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
}

declare interface Navigator {
  bluetooth: Bluetooth;
}

declare interface BluetoothRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(
    service: BluetoothServiceUUID,
  ): Promise<BluetoothRemoteGATTService>;
}

declare interface BluetoothDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
}

declare interface BluetoothRemoteGATTService {
  getCharacteristic(
    characteristic: BluetoothServiceUUID,
  ): Promise<BluetoothRemoteGATTCharacteristic>;
}

declare interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  value?: DataView;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
}
