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
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.startManualScan, () =>
    runtime.startManualScan(),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.pairDiscoveredNode, (_event, candidateId) =>
    runtime.pairDiscoveredNode(candidateId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.pairManualCandidate, (_event, candidateId) =>
    runtime.pairManualCandidate(candidateId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.forgetNode, (_event, nodeId) =>
    runtime.forgetNode(nodeId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.recoverApprovedNode, (_event, ruleId) =>
    runtime.recoverApprovedNode(ruleId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.resumeReconnectForNode, (_event, nodeId) =>
    runtime.resumeReconnectForNode(nodeId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.resumeApprovedNodeReconnect, (_event, ruleId) =>
    runtime.resumeApprovedNodeReconnect(ruleId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.setAllowedNodes, (_event, nodes) =>
    runtime.setAllowedNodes(nodes),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.getDeviceAnalytics, (_event, deviceId, range) =>
    runtime.getDeviceAnalytics(deviceId, range),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.refreshDeviceAnalytics, (_event, deviceId, range) =>
    runtime.refreshDeviceAnalytics(deviceId, range),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.requestDeviceHistorySync, (_event, deviceId) =>
    runtime.requestDeviceHistorySync(deviceId),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.deleteDeviceAnalyticsHistory, (_event, deviceId) =>
    runtime.deleteDeviceAnalyticsHistory(deviceId),
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
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.startManualScan);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.pairDiscoveredNode);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.pairManualCandidate);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.forgetNode);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.recoverApprovedNode);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.resumeReconnectForNode);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.resumeApprovedNodeReconnect);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.setAllowedNodes);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.getDeviceAnalytics);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.refreshDeviceAnalytics);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.requestDeviceHistorySync);
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.deleteDeviceAnalyticsHistory);
    },
  };
}
