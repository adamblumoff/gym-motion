import { contextBridge, ipcRenderer } from "electron";

import type {
  ApprovedNodeRule,
  GetDeviceAnalyticsInput,
  ThemePreference,
} from "@core/contracts";
import {
  DESKTOP_GATEWAY_ADMIN_CHANNELS,
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
  async startManualScan() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.startManualScan);
  },
  async pairDiscoveredNode(candidateId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.pairDiscoveredNode, candidateId);
  },
  async pairManualCandidate(candidateId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.pairManualCandidate, candidateId);
  },
  async forgetNode(nodeId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.forgetNode, nodeId);
  },
  async recoverApprovedNode(ruleId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.recoverApprovedNode, ruleId);
  },
  async resumeReconnectForNode(nodeId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.resumeReconnectForNode, nodeId);
  },
  async resumeApprovedNodeReconnect(ruleId: string) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.resumeApprovedNodeReconnect, ruleId);
  },
  async setAllowedNodes(nodes: ApprovedNodeRule[]) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.setAllowedNodes, nodes);
  },
  async getDeviceAnalytics(input: GetDeviceAnalyticsInput) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.getDeviceAnalytics, input);
  },
  async getDeviceActivity(deviceId: string, limit?: number) {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_CHANNELS.getDeviceActivity, deviceId, limit);
  },
  async getGatewayAdminConfig() {
    return ipcRenderer.invoke(DESKTOP_GATEWAY_ADMIN_CHANNELS.getConfig);
  },
  async saveGatewayAdminConfig(config) {
    return ipcRenderer.invoke(DESKTOP_GATEWAY_ADMIN_CHANNELS.saveConfig, config);
  },
  async runGatewayAdminCommand(input) {
    return ipcRenderer.invoke(DESKTOP_GATEWAY_ADMIN_CHANNELS.runCommand, input);
  },
  async checkGatewayAdminReadiness(gatewayId) {
    return ipcRenderer.invoke(DESKTOP_GATEWAY_ADMIN_CHANNELS.checkReadiness, gatewayId);
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
