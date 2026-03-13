"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { fetchGatewayJson, normalizeGatewayBaseUrl } from "@/lib/gateway-connection";

import { useGatewayConnection } from "./gateway-connection-provider";
import styles from "./gateway-connection-panel.module.css";

type HealthResponse = {
  ok: boolean;
  gateway: {
    hostname: string;
    mode: string;
  };
};

type Props = {
  compact?: boolean;
};

export function GatewayConnectionPanel({ compact = false }: Props) {
  const { currentOrigin, gatewayBaseUrl, setGatewayBaseUrl } = useGatewayConnection();
  const [inputValue, setInputValue] = useState(gatewayBaseUrl ?? currentOrigin ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentGatewayLabel = useMemo(() => {
    if (!gatewayBaseUrl) {
      return "No gateway selected";
    }

    try {
      return new URL(gatewayBaseUrl).host;
    } catch {
      return gatewayBaseUrl;
    }
  }, [gatewayBaseUrl]);

  async function handleSave() {
    const nextBaseUrl = normalizeGatewayBaseUrl(inputValue);

    if (!nextBaseUrl) {
      setError("Enter a valid gateway hostname or URL.");
      setStatus(null);
      return;
    }

    setError(null);
    setStatus("Checking gateway…");

    try {
      const response = await fetchGatewayJson<HealthResponse>(
        nextBaseUrl,
        "/api/health",
      );

      setGatewayBaseUrl(nextBaseUrl);
      setStatus(`Connected to ${response.gateway.hostname}.`);
    } catch {
      setError("Could not reach that gateway from this browser.");
      setStatus(null);
    }
  }

  return (
    <section className={styles.card} data-compact={compact}>
      <div className={styles.copy}>
        <span className={styles.label}>Gateway</span>
        <strong>{currentGatewayLabel}</strong>
        <span className={styles.hint}>
          Use the gateway hostname on this Wi-Fi, ideally a `.local` mDNS name.
        </span>
      </div>

      <div className={styles.controls}>
        <input
          className={styles.input}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder="gym-motion-gateway.local:3000"
          value={inputValue}
        />
        <button className={styles.button} onClick={() => void handleSave()} type="button">
          Connect
        </button>
        {!compact ? (
          <Link className={styles.link} href="/connect">
            Open setup
          </Link>
        ) : null}
      </div>

      {status ? <p className={styles.status}>{status}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}
    </section>
  );
}
