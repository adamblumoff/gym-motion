import type { MotionStreamPayload } from "@/lib/motion";

type MotionSubscriber = (payload: MotionStreamPayload) => void;

declare global {
  var motionSubscribers: Set<MotionSubscriber> | undefined;
}

function getSubscribers() {
  if (!globalThis.motionSubscribers) {
    globalThis.motionSubscribers = new Set<MotionSubscriber>();
  }

  return globalThis.motionSubscribers;
}

export function subscribeToMotionUpdates(subscriber: MotionSubscriber) {
  const subscribers = getSubscribers();
  subscribers.add(subscriber);

  return () => {
    subscribers.delete(subscriber);
  };
}

export function broadcastMotionUpdate(payload: MotionStreamPayload) {
  for (const subscriber of getSubscribers()) {
    subscriber(payload);
  }
}
