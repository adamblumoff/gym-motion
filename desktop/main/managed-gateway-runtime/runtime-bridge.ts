import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { app } from "electron";

import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  GatewayStatusSummary,
} from "@core/contracts";

import { resolveGatewayScriptPath, resolveWindowsSidecarPath } from "../gateway-runtime-target";
import { EMPTY_GATEWAY } from "./snapshot";
import { fetchJson } from "./common";

type RuntimeBridgeDeps = {
  getChild: () => ChildProcess | null;
  setChild: (child: ChildProcess | null) => void;
  getRuntimePort: () => number;
  setRuntimePort: (port: number) => void;
  selectedAdapter: () => BleAdapterSummary | null;
  readApprovedNodes: () => ApprovedNodeRule[];
  getWindowsScanRequested: () => boolean;
  getStopped: () => boolean;
  intentionalChildExits: WeakSet<ChildProcess>;
  clearWindowsAdapterRetryTimer: () => void;
  updateGatewayStatus: (
    gateway: GatewayStatusSummary,
    runtimeState: "starting" | "running" | "degraded" | "restarting",
    issue: string | null,
  ) => void;
  apiBaseUrl: string;
};

export type RuntimeBridge = {
  sendGatewayCommand: (command: Record<string, unknown>) => Promise<void>;
  sendGatewayCommandInBackground: (command: Record<string, unknown>, context: string) => void;
  stopChild: () => void;
  runtimeStartIssue: () => string | null;
  startChild: () => Promise<void>;
};

export function createRuntimeBridge(deps: RuntimeBridgeDeps): RuntimeBridge {
  async function sendGatewayCommand(command: Record<string, unknown>) {
    const child = deps.getChild();
    const runtimePort = deps.getRuntimePort();

    if (!child || child.killed) {
      throw new Error("Gateway runtime is not running.");
    }

    const response = await fetch(`http://127.0.0.1:${runtimePort}/control`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`gateway control -> ${response.status}: ${text}`);
    }
  }

  function sendGatewayCommandInBackground(
    command: Record<string, unknown>,
    context: string,
  ) {
    void sendGatewayCommand(command).catch((error) => {
      console.error(`[runtime] failed to ${context}`, error);
    });
  }

  function stopChild() {
    const child = deps.getChild();
    if (!child) {
      return;
    }

    deps.clearWindowsAdapterRetryTimer();

    deps.intentionalChildExits.add(child);
    deps.setChild(null);
    child.kill("SIGTERM");
  }

  function runtimeStartIssue() {
    return null;
  }

  async function startChild() {
    const adapter = deps.selectedAdapter();

    const runtimePort = 4010 + Math.floor(Math.random() * 2000);
    deps.setRuntimePort(runtimePort);
    const env: Record<string, string | undefined> = {
      ...process.env,
      API_URL: deps.apiBaseUrl,
      GATEWAY_RUNTIME_HOST: "127.0.0.1",
      GATEWAY_RUNTIME_PORT: String(runtimePort),
      GATEWAY_APPROVED_NODE_RULES: JSON.stringify(deps.readApprovedNodes()),
    };

    env.GATEWAY_SELECTED_ADAPTER_ID = adapter?.id ?? "";
    env.GATEWAY_START_SCAN_ON_BOOT = deps.getWindowsScanRequested() ? "1" : "0";
    env.GATEWAY_SIDECAR_PATH = resolveWindowsSidecarPath({
      isPackaged: app.isPackaged,
      cwd: process.cwd(),
      resourcesPath: process.resourcesPath,
    });

    const spawnedChild = spawn(
      process.execPath,
      [
        resolveGatewayScriptPath({
          platform: process.platform,
          isPackaged: app.isPackaged,
          cwd: process.cwd(),
          resourcesPath: process.resourcesPath,
        }),
      ],
      {
        cwd: app.isPackaged ? process.resourcesPath : process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    deps.setChild(spawnedChild);

    spawnedChild.stdout?.on("data", (chunk) => {
      process.stdout.write(`[gateway] ${chunk}`);
    });
    spawnedChild.stderr?.on("data", (chunk) => {
      process.stderr.write(`[gateway] ${chunk}`);
    });
    spawnedChild.once("exit", (code, signal) => {
      const wasIntentional = deps.intentionalChildExits.has(spawnedChild);

      if (deps.getChild() === spawnedChild) {
        deps.setChild(null);
      }

      if (deps.getStopped() || wasIntentional) {
        return;
      }

      deps.updateGatewayStatus(
        { ...EMPTY_GATEWAY, updatedAt: new Date().toISOString() },
        "degraded",
        `Gateway exited (${signal ?? code ?? "unknown"}).`,
      );
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await fetchJson(`${`http://127.0.0.1:${runtimePort}`}/health`);
        return;
      } catch {
        await delay(500);
      }
    }

    throw new Error("Gateway runtime did not become healthy.");
  }

  return {
    sendGatewayCommand,
    sendGatewayCommandInBackground,
    stopChild,
    runtimeStartIssue,
    startChild,
  };
}
