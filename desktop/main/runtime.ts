import { BrowserWindow, ipcMain } from "electron";

import { createMockRuntime } from "@core/mock-runtime";
import type { DesktopSnapshot } from "@core/contracts";
import { DESKTOP_RUNTIME_CHANNELS } from "@core/services";

export function registerRuntimeBridge(getWindows: () => BrowserWindow[]) {
  const runtime = createMockRuntime();

  function broadcast(snapshot: DesktopSnapshot) {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(DESKTOP_RUNTIME_CHANNELS.updated, { snapshot });
      }
    }
  }

  const unsubscribe = runtime.onUpdated((snapshot) => {
    broadcast(snapshot);
  });

  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.getSnapshot, () => runtime.getSnapshot());
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.triggerDemoBurst, () => {
    runtime.triggerDemoBurst();
  });
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.setEnvironment, (_event, environment) =>
    runtime.setEnvironment(environment),
  );

  runtime.start();

  return {
    dispose() {
      unsubscribe();
      runtime.stop();
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.getSnapshot);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.triggerDemoBurst);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.setEnvironment);
    },
  };
}
