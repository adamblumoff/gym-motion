"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

import {
  getCurrentOrigin,
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
  const currentOrigin = getCurrentOrigin();

  const value = useMemo(
    () => ({
      gatewayBaseUrl: currentOrigin,
      currentOrigin,
      setGatewayBaseUrl: () => {},
    }),
    [currentOrigin],
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
