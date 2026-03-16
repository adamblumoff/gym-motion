import { BrowserWindow, ipcMain } from "electron";

import {
  DESKTOP_RUNTIME_CHANNELS,
  type DesktopRuntimeEvent,
} from "@core/services";
import { createManagedGatewayRuntime } from "./managed-gateway-runtime";
import type { PreferencesStore } from "./preferences-store";

export function registerRuntimeBridge(
  getWindows: () => BrowserWindow[],
  preferences: PreferencesStore,
) {
  const runtime = createManagedGatewayRuntime(preferences);

  function broadcast(event: DesktopRuntimeEvent) {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(DESKTOP_RUNTIME_CHANNELS.updated, event);
      }
    }
  }

  const unsubscribe = runtime.onEvent((event) => {
    broadcast(event);
  });

  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.getSnapshot, () => runtime.getSnapshot());
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.getSetupState, () => runtime.getSetupState());
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.restartGatewayRuntime, () => runtime.restart());
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.rescanAdapters, () => runtime.rescanAdapters());
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.requestSilentReconnect, () =>
    runtime.requestSilentReconnect(),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.recoverApprovedNode, (_event, ruleId) =>
    runtime.recoverApprovedNode(ruleId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.resumeApprovedNodeReconnect, (_event, ruleId) =>
    runtime.resumeApprovedNodeReconnect(ruleId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.setAllowedNodes, (_event, nodes) =>
    runtime.setAllowedNodes(nodes),
  );

  void runtime.start().catch((error) => {
    console.error("[runtime] failed to start managed gateway runtime", error);
  });

  return {
    async dispose() {
      unsubscribe();
      await runtime.stop();
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.getSnapshot);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.getSetupState);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.restartGatewayRuntime);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.rescanAdapters);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.requestSilentReconnect);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.recoverApprovedNode);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.resumeApprovedNodeReconnect);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.setAllowedNodes);
    },
  };
}
