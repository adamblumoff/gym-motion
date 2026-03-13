"use client";

import { useEffect, useState } from "react";

import { fetchGatewayJson } from "@/lib/gateway-connection";
import type { GatewayHealthResponse } from "@/lib/motion";

import { useGatewayConnection } from "./gateway-connection-provider";
import styles from "./gateway-connection-panel.module.css";

type Props = {
  compact?: boolean;
};

function formatAdapterState(adapterState: string) {
  switch (adapterState) {
    case "poweredOn":
      return "Bluetooth ready";
    case "unavailable":
      return "Gateway runtime offline";
    default:
      return `Bluetooth ${adapterState}`;
  }
}

function formatScanState(scanState: string) {
  switch (scanState) {
    case "scanning":
      return "Scanning for BLE nodes";
    case "stopped":
      return "Not scanning";
    default:
      return `Scan ${scanState}`;
  }
}

export function GatewayConnectionPanel({ compact = false }: Props) {
  const { gatewayBaseUrl } = useGatewayConnection();
  const [payload, setPayload] = useState<GatewayHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const nextPayload = await fetchGatewayJson<GatewayHealthResponse>(
          gatewayBaseUrl,
          "/api/gateway/health",
        );

        if (!cancelled) {
          setPayload(nextPayload);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("The operator console can’t reach the local gateway runtime yet.");
        }
      }
    }

    void loadHealth();
    const intervalId = setInterval(() => {
      void loadHealth();
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [gatewayBaseUrl]);

  const gateway = payload?.gateway ?? null;
  const hostLabel = gateway ? `${gateway.hostname}:3000` : gatewayBaseUrl ?? "Current host";

  return (
    <section className={styles.card} data-compact={compact}>
      <div className={styles.copy}>
        <span className={styles.label}>Gateway host</span>
        <strong>{hostLabel}</strong>
        <span className={styles.hint}>
          This console automatically uses the same host that served the page. Open the
          app on the Linux gateway host and the frontend follows it automatically.
        </span>
      </div>

      {gateway ? (
        <div className={styles.controls}>
          <div className={styles.statusPill}>{formatAdapterState(gateway.adapterState)}</div>
          <div className={styles.statusPill}>{formatScanState(gateway.scanState)}</div>
          <div className={styles.statusPill}>
            {gateway.connectedNodeCount} connected
          </div>
          <div className={styles.statusPill}>
            {gateway.reconnectingNodeCount} reconnecting
          </div>
        </div>
      ) : null}

      {payload?.error ? <p className={styles.error}>{payload.error}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}
