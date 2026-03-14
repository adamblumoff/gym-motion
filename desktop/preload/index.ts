import { contextBridge, ipcRenderer } from "electron";

import type { DesktopEnvironment } from "@core/contracts";
import {
  DESKTOP_RUNTIME_CHANNELS,
  type DesktopApi,
} from "@core/services";

const desktopApi: DesktopApi = {
  async getSnapshot() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.getSnapshot);
  },
  async triggerDemoBurst() {
    await ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.triggerDemoBurst);
  },
  async setEnvironment(environment: DesktopEnvironment) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.setEnvironment, environment);
  },
  subscribe(listener) {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(DESKTOP_RUNTIME_CHANNELS.updated, wrappedListener);

    return () => {
      ipcRenderer.removeListener(DESKTOP_RUNTIME_CHANNELS.updated, wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld("gymMotionDesktop", desktopApi);
