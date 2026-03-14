import os from "node:os";

import type { GatewayHealthResponse, GatewayRuntimeDevicesResponse } from "@/lib/motion";

const DEFAULT_GATEWAY_RUNTIME_PORT = Number(process.env.GATEWAY_RUNTIME_PORT ?? 4010);
const DEFAULT_GATEWAY_RUNTIME_HOST = process.env.GATEWAY_RUNTIME_HOST ?? "127.0.0.1";

function getGatewayRuntimeOrigin() {
  return `http://${DEFAULT_GATEWAY_RUNTIME_HOST}:${DEFAULT_GATEWAY_RUNTIME_PORT}`;
}

function createUnavailableGatewayHealth(error?: string): GatewayHealthResponse {
  return {
    ok: false,
    gateway: {
      hostname: os.hostname(),
      mode: "reference-ble-node-gateway",
      sessionId: "unavailable",
      adapterState: "unavailable",
      scanState: "stopped",
      connectedNodeCount: 0,
      reconnectingNodeCount: 0,
      knownNodeCount: 0,
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date().toISOString(),
      lastAdvertisementAt: null,
    },
    error: error ?? "Gateway runtime is not reachable.",
  };
}

export async function getGatewayRuntimeHealth(): Promise<GatewayHealthResponse> {
  try {
    const response = await fetch(`${getGatewayRuntimeOrigin()}/health`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`/health -> ${response.status}`);
    }

    return (await response.json()) as GatewayHealthResponse;
  } catch (error) {
    return createUnavailableGatewayHealth(
      error instanceof Error ? error.message : "Gateway runtime is not reachable.",
    );
  }
}

export async function getGatewayRuntimeDevices(): Promise<GatewayRuntimeDevicesResponse> {
  try {
    const response = await fetch(`${getGatewayRuntimeOrigin()}/devices`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`/devices -> ${response.status}`);
    }

    return (await response.json()) as GatewayRuntimeDevicesResponse;
  } catch (error) {
    const health = createUnavailableGatewayHealth(
      error instanceof Error ? error.message : "Gateway runtime is not reachable.",
    );

    return {
      ok: false,
      gateway: health.gateway,
      devices: [],
      error: health.error,
    };
  }
}

export async function proxyGatewayRuntimeStream() {
  const response = await fetch(`${getGatewayRuntimeOrigin()}/stream`, {
    cache: "no-store",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-store",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Gateway runtime stream unavailable (${response.status}).`);
  }

  return response;
}
