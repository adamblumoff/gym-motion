"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { buildGatewayUrl } from "@/lib/gateway-connection";
import type {
  DeviceLogStreamPayload,
  MotionStreamPayload,
} from "@/lib/motion";
import { useGatewayConnection } from "./gateway-connection-provider";

type MotionListener = (payload: MotionStreamPayload) => void;
type DeviceLogListener = (payload: DeviceLogStreamPayload) => void;

type LiveStreamContextValue = {
  liveStatus: string;
  subscribeToMotion: (listener: MotionListener) => () => void;
  subscribeToDeviceLogs: (listener: DeviceLogListener) => () => void;
};

const LiveStreamContext = createContext<LiveStreamContextValue | null>(null);

export function LiveStreamProvider({ children }: { children: ReactNode }) {
  const [liveStatus, setLiveStatus] = useState("Connecting…");
  const motionListeners = useRef(new Set<MotionListener>());
  const deviceLogListeners = useRef(new Set<DeviceLogListener>());
  const { gatewayBaseUrl } = useGatewayConnection();

  useEffect(() => {
    if (!gatewayBaseUrl) {
      return;
    }

    const eventSource = new EventSource(
      buildGatewayUrl(gatewayBaseUrl, "/api/stream"),
    );

    eventSource.addEventListener("motion-update", (rawEvent) => {
      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as MotionStreamPayload;

      for (const listener of motionListeners.current) {
        listener(payload);
      }
    });

    eventSource.addEventListener("device-log", (rawEvent) => {
      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as DeviceLogStreamPayload;

      for (const listener of deviceLogListeners.current) {
        listener(payload);
      }
    });

    eventSource.onopen = () => {
      setLiveStatus("Live");
    };

    eventSource.onerror = () => {
      setLiveStatus("Reconnecting…");
    };

    return () => {
      eventSource.close();
    };
  }, [gatewayBaseUrl]);

  const subscribeToMotion = useCallback((listener: MotionListener) => {
    motionListeners.current.add(listener);

    return () => {
      motionListeners.current.delete(listener);
    };
  }, []);

  const subscribeToDeviceLogs = useCallback((listener: DeviceLogListener) => {
    deviceLogListeners.current.add(listener);

    return () => {
      deviceLogListeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<LiveStreamContextValue>(
    () => ({
      liveStatus: gatewayBaseUrl ? liveStatus : "Pick a gateway",
      subscribeToMotion,
      subscribeToDeviceLogs,
    }),
    [gatewayBaseUrl, liveStatus, subscribeToMotion, subscribeToDeviceLogs],
  );

  return (
    <LiveStreamContext.Provider value={value}>
      {children}
    </LiveStreamContext.Provider>
  );
}

export function useLiveStream() {
  const context = useContext(LiveStreamContext);

  if (!context) {
    throw new Error("useLiveStream must be used inside LiveStreamProvider.");
  }

  return context;
}
