import type {
  DeviceLogStreamPayload,
  MotionStreamPayload,
} from "@/lib/motion";

type MotionSubscriber = (payload: MotionStreamPayload) => void;
type DeviceLogSubscriber = (payload: DeviceLogStreamPayload) => void;

declare global {
  var motionSubscribers: Set<MotionSubscriber> | undefined;
  var deviceLogSubscribers: Set<DeviceLogSubscriber> | undefined;
}

function getMotionSubscribers() {
  if (!globalThis.motionSubscribers) {
    globalThis.motionSubscribers = new Set<MotionSubscriber>();
  }

  return globalThis.motionSubscribers;
}

function getDeviceLogSubscribers() {
  if (!globalThis.deviceLogSubscribers) {
    globalThis.deviceLogSubscribers = new Set<DeviceLogSubscriber>();
  }

  return globalThis.deviceLogSubscribers;
}

export function subscribeToMotionUpdates(subscriber: MotionSubscriber) {
  const subscribers = getMotionSubscribers();
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
}

export function subscribeToDeviceLogs(subscriber: DeviceLogSubscriber) {
  const subscribers = getDeviceLogSubscribers();
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
}

export function broadcastMotionUpdate(payload: MotionStreamPayload) {
  for (const subscriber of getMotionSubscribers()) {
    subscriber(payload);
  }
}

export function broadcastDeviceLog(payload: DeviceLogStreamPayload) {
  for (const subscriber of getDeviceLogSubscribers()) {
    subscriber(payload);
  }
}
