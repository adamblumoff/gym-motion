import { contextBridge, ipcRenderer } from "electron";

import type { ApprovedNodeRule, ThemePreference } from "@core/contracts";
import {
  DESKTOP_THEME_CHANNELS,
  DESKTOP_RUNTIME_CHANNELS,
  type DesktopApi,
} from "@core/services";

const desktopApi: DesktopApi = {
  async getSnapshot() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.getSnapshot);
  },
  async getSetupState() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.getSetupState);
  },
  async restartGatewayRuntime() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.restartGatewayRuntime);
  },
  async rescanAdapters() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.rescanAdapters);
  },
  async requestSilentReconnect() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.requestSilentReconnect);
  },
  async recoverApprovedNode(ruleId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.recoverApprovedNode, ruleId);
  },
  async resumeApprovedNodeReconnect(ruleId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.resumeApprovedNodeReconnect, ruleId);
  },
  async setAllowedNodes(nodes: ApprovedNodeRule[]) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.setAllowedNodes, nodes);
  },
  subscribeRuntime(listener) {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(DESKTOP_RUNTIME_CHANNELS.updated, wrappedListener);

    return () => {
      ipcRenderer.removeListener(DESKTOP_RUNTIME_CHANNELS.updated, wrappedListener);
    };
  },
  async getThemeState() {
    return ipcRenderer.invoke(DESKTOP_THEME_CHANNELS.getState);
  },
  async setThemePreference(preference: ThemePreference) {
    return ipcRenderer.invoke(DESKTOP_THEME_CHANNELS.setPreference, preference);
  },
  subscribeTheme(listener) {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(DESKTOP_THEME_CHANNELS.updated, wrappedListener);

    return () => {
      ipcRenderer.removeListener(DESKTOP_THEME_CHANNELS.updated, wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld("gymMotionDesktop", desktopApi);
