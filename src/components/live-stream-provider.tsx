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

import { buildGatewayUrl, fetchGatewayJson } from "@/lib/gateway-connection";
import type {
  DeviceLogStreamPayload,
  GatewayDeviceStreamPayload,
  GatewayHealthResponse,
  MotionStreamPayload,
} from "@/lib/motion";
import { useGatewayConnection } from "./gateway-connection-provider";

type MotionListener = (payload: MotionStreamPayload) => void;
type DeviceLogListener = (payload: DeviceLogStreamPayload) => void;
type GatewayDeviceListener = (payload: GatewayDeviceStreamPayload) => void;

type LiveStreamContextValue = {
  liveStatus: string;
  gatewayHealth: GatewayHealthResponse | null;
  subscribeToMotion: (listener: MotionListener) => () => void;
  subscribeToDeviceLogs: (listener: DeviceLogListener) => () => void;
  subscribeToGatewayDevices: (listener: GatewayDeviceListener) => () => void;
};

const LiveStreamContext = createContext<LiveStreamContextValue | null>(null);

export function LiveStreamProvider({ children }: { children: ReactNode }) {
  const [liveStatus, setLiveStatus] = useState("Gateway offline");
  const [gatewayHealth, setGatewayHealth] = useState<GatewayHealthResponse | null>(null);
  const motionListeners = useRef(new Set<MotionListener>());
  const deviceLogListeners = useRef(new Set<DeviceLogListener>());
  const gatewayDeviceListeners = useRef(new Set<GatewayDeviceListener>());
  const { gatewayBaseUrl } = useGatewayConnection();

  useEffect(() => {
    if (!gatewayBaseUrl) {
      return;
    }

    let cancelled = false;

    async function loadHealth() {
      const payload = await fetchGatewayJson<GatewayHealthResponse>(
        gatewayBaseUrl,
        "/api/gateway/health",
      );

      if (cancelled) {
        return;
      }

      setGatewayHealth(payload);
      setLiveStatus(payload.ok ? "Gateway live" : "Gateway offline");
    }

    void loadHealth().catch(() => {
      if (!cancelled) {
        setLiveStatus("Gateway offline");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [gatewayBaseUrl]);

  useEffect(() => {
    if (!gatewayBaseUrl) {
      return;
    }

    const gatewaySource = new EventSource(
      buildGatewayUrl(gatewayBaseUrl, "/api/gateway/stream"),
    );
    const appSource = new EventSource(buildGatewayUrl(gatewayBaseUrl, "/api/stream"));

    gatewaySource.addEventListener("gateway-status", (rawEvent) => {
      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as GatewayHealthResponse;
      setGatewayHealth(payload);
      setLiveStatus(payload.ok ? "Gateway live" : "Gateway offline");
    });

    gatewaySource.addEventListener("gateway-device", (rawEvent) => {
      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as GatewayDeviceStreamPayload;

      for (const listener of gatewayDeviceListeners.current) {
        listener(payload);
      }
    });

    gatewaySource.onopen = () => {
      setLiveStatus("Gateway live");
    };

    gatewaySource.onerror = () => {
      setLiveStatus("Gateway reconnecting…");
    };

    appSource.addEventListener("motion-update", (rawEvent) => {
      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as MotionStreamPayload;

      for (const listener of motionListeners.current) {
        listener(payload);
      }
    });

    appSource.addEventListener("device-log", (rawEvent) => {
      const event = rawEvent as MessageEvent<string>;
      const payload = JSON.parse(event.data) as DeviceLogStreamPayload;

      for (const listener of deviceLogListeners.current) {
        listener(payload);
      }
    });

    return () => {
      gatewaySource.close();
      appSource.close();
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

  const subscribeToGatewayDevices = useCallback((listener: GatewayDeviceListener) => {
    gatewayDeviceListeners.current.add(listener);

    return () => {
      gatewayDeviceListeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<LiveStreamContextValue>(
    () => ({
      liveStatus: gatewayBaseUrl ? liveStatus : "Gateway unavailable",
      gatewayHealth,
      subscribeToMotion,
      subscribeToDeviceLogs,
      subscribeToGatewayDevices,
    }),
    [
      gatewayBaseUrl,
      gatewayHealth,
      liveStatus,
      subscribeToDeviceLogs,
      subscribeToGatewayDevices,
      subscribeToMotion,
    ],
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
