import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { app } from "electron";

import type {
  ApprovedNodeRule,
  BleAdapterSummary,
  GatewayStatusSummary,
} from "@core/contracts";

import { resolveGatewayScriptPath, resolveWindowsSidecarPath } from "../gateway-runtime-target";
import { buildGatewayChildEnv } from "./gateway-child-env";
import {
  parseGatewayChildMessage,
  type GatewayChildControlResponseMessage,
  type GatewayChildMessage,
  type GatewayChildPersistMessage,
  type GatewayChildRuntimeMessage,
} from "./gateway-child-ipc";
import { EMPTY_GATEWAY } from "./snapshot";

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
  getApiBaseUrl: () => string;
  onChildPersistMessage: (message: GatewayChildPersistMessage) => Promise<void>;
  onChildRuntimeMessage: (message: GatewayChildRuntimeMessage) => void;
  commandTimeoutMs?: number;
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type RuntimeBridge = {
  dispatchGatewayCommand: (command: Record<string, unknown>) => Promise<void>;
  sendGatewayCommand: (command: Record<string, unknown>) => Promise<unknown>;
  sendGatewayCommandInBackground: (command: Record<string, unknown>, context: string) => void;
  stopChild: () => void;
  runtimeStartIssue: () => string | null;
  startChild: () => Promise<void>;
};

function isControlResponse(
  message: GatewayChildMessage,
): message is GatewayChildControlResponseMessage {
  return message.type === "control-response";
}

function canSendGatewayCommand(
  child: ChildProcess | null,
): child is ChildProcess & { send: (message: unknown, callback?: (error: Error | null) => void) => boolean } {
  return (
    !!child &&
    !child.killed &&
    child.connected !== false &&
    typeof child.send === "function"
  );
}

export function createRuntimeBridge(deps: RuntimeBridgeDeps): RuntimeBridge {
  const pendingCommands = new Map<string, PendingCommand>();
  const commandTimeoutMs = deps.commandTimeoutMs ?? 5_000;
  let readyResolver: (() => void) | null = null;
  let readyRejecter: ((error: Error) => void) | null = null;

  function rejectPendingCommands(error: Error) {
    for (const pending of pendingCommands.values()) {
      pending.reject(error);
    }

    pendingCommands.clear();
  }

  function resolveReady() {
    readyResolver?.();
    readyResolver = null;
    readyRejecter = null;
  }

  function rejectReady(error: Error) {
    readyRejecter?.(error);
    readyResolver = null;
    readyRejecter = null;
  }

  async function dispatchGatewayCommand(command: Record<string, unknown>) {
    const child = deps.getChild();

    if (!canSendGatewayCommand(child)) {
      throw new Error("Gateway runtime is not running.");
    }

    await new Promise<void>((resolve, reject) => {
      child.send(command, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async function sendGatewayCommand(command: Record<string, unknown>) {
    const child = deps.getChild();

    if (!canSendGatewayCommand(child)) {
      throw new Error("Gateway runtime is not running.");
    }

    const commandId = randomUUID();
    const commandType =
      typeof command.type === "string" && command.type.length > 0
        ? command.type
        : "unknown";

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(commandId);
        reject(new Error(`Gateway command timed out: ${commandType}.`));
      }, commandTimeoutMs);
      timeout.unref?.();

      pendingCommands.set(commandId, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });

      child.send({ commandId, ...command }, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timeout);
        pendingCommands.delete(commandId);
        reject(error);
      });
    });
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
    rejectPendingCommands(new Error("Gateway runtime stopped."));
    rejectReady(new Error("Gateway runtime stopped before becoming ready."));

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
    const env: Record<string, string | undefined> = buildGatewayChildEnv({
      processEnv: process.env,
      getApiBaseUrl: deps.getApiBaseUrl,
      runtimePort,
      approvedNodes: deps.readApprovedNodes(),
    });

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
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    deps.setChild(spawnedChild);

    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolver = resolve;
      readyRejecter = reject;
    });
    const readyTimeout = setTimeout(() => {
      rejectReady(new Error("Gateway runtime did not become ready."));
    }, 15_000);
    readyTimeout.unref?.();

    spawnedChild.stdout?.on("data", (chunk) => {
      process.stdout.write(`[gateway] ${chunk}`);
    });
    spawnedChild.stderr?.on("data", (chunk) => {
      process.stderr.write(`[gateway] ${chunk}`);
    });
    spawnedChild.on("message", (message) => {
      const parsedMessage = parseGatewayChildMessage(message);

      if (!parsedMessage) {
        console.error("[runtime] ignored invalid gateway child IPC message", message);
        return;
      }

      if (isControlResponse(parsedMessage)) {
        const pending = pendingCommands.get(parsedMessage.commandId);

        if (!pending) {
          return;
        }

        pendingCommands.delete(parsedMessage.commandId);

        if (parsedMessage.ok) {
          pending.resolve(parsedMessage.result);
        } else {
          pending.reject(new Error(parsedMessage.error ?? "Gateway command failed."));
        }

        return;
      }

      if (parsedMessage.type === "runtime-ready") {
        deps.onChildRuntimeMessage(parsedMessage);
        resolveReady();
        return;
      }

      if (
        parsedMessage.type === "gateway-state" ||
        parsedMessage.type === "adapters-updated" ||
        parsedMessage.type === "manual-scan-updated" ||
        parsedMessage.type === "runtime-device-updated"
      ) {
        deps.onChildRuntimeMessage(parsedMessage);
        return;
      }

      void deps.onChildPersistMessage(parsedMessage).catch((error) => {
        console.error(
          `[runtime] failed to persist gateway child message ${parsedMessage.type} for ${parsedMessage.deviceId}`,
          error,
        );
      });
    });
    spawnedChild.once("exit", (code, signal) => {
      const wasIntentional = deps.intentionalChildExits.has(spawnedChild);

      if (deps.getChild() === spawnedChild) {
        deps.setChild(null);
      }

      rejectPendingCommands(
        new Error(`Gateway exited (${signal ?? code ?? "unknown"}).`),
      );
      rejectReady(new Error(`Gateway exited (${signal ?? code ?? "unknown"}).`));

      if (deps.getStopped() || wasIntentional) {
        return;
      }

      deps.updateGatewayStatus(
        { ...EMPTY_GATEWAY, updatedAt: new Date().toISOString() },
        "degraded",
        `Gateway exited (${signal ?? code ?? "unknown"}).`,
      );
    });

    try {
      await readyPromise;
    } finally {
      clearTimeout(readyTimeout);
    }
  }

  return {
    dispatchGatewayCommand,
    sendGatewayCommand,
    sendGatewayCommandInBackground,
    stopChild,
    runtimeStartIssue,
    startChild,
  };
}
