"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  getCurrentOrigin,
  normalizeGatewayBaseUrl,
  persistGatewayBaseUrl,
  readSavedGatewayBaseUrl,
} from "@/lib/gateway-connection";

type GatewayConnectionContextValue = {
  gatewayBaseUrl: string | null;
  currentOrigin: string | null;
  setGatewayBaseUrl: (value: string | null) => void;
};

const GatewayConnectionContext =
  createContext<GatewayConnectionContextValue | null>(null);

export function GatewayConnectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [connectionState, setConnectionState] = useState(() => {
    const currentOrigin = getCurrentOrigin();
    const savedGateway = readSavedGatewayBaseUrl();

    return {
      currentOrigin,
      gatewayBaseUrl: savedGateway ?? currentOrigin,
    };
  });

  const setGatewayBaseUrl = useCallback((value: string | null) => {
    const normalizedValue = normalizeGatewayBaseUrl(value ?? "");
    const nextValue = normalizedValue ?? connectionState.currentOrigin;
    persistGatewayBaseUrl(nextValue);
    setConnectionState((current) => ({
      ...current,
      gatewayBaseUrl: nextValue,
    }));
  }, [connectionState.currentOrigin]);

  const value = useMemo(
    () => ({
      gatewayBaseUrl: connectionState.gatewayBaseUrl,
      currentOrigin: connectionState.currentOrigin,
      setGatewayBaseUrl,
    }),
    [connectionState, setGatewayBaseUrl],
  );

  return (
    <GatewayConnectionContext.Provider value={value}>
      {children}
    </GatewayConnectionContext.Provider>
  );
}

export function useGatewayConnection() {
  const context = useContext(GatewayConnectionContext);

  if (!context) {
    throw new Error(
      "useGatewayConnection must be used inside GatewayConnectionProvider.",
    );
  }

  return context;
}
