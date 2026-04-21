import { BrowserWindow, ipcMain } from "electron";

import {
  DESKTOP_RUNTIME_CHANNELS,
  type DesktopRuntimeEvent,
} from "@core/services";
import { createCloudRuntime } from "./cloud-runtime";

export function registerRuntimeBridge(
  getWindows: () => BrowserWindow[],
) {
  const cloudApiBaseUrl = process.env.GYM_MOTION_CLOUD_API_BASE_URL?.trim();
  if (!cloudApiBaseUrl) {
    throw new Error(
      "GYM_MOTION_CLOUD_API_BASE_URL is required. The desktop app now runs as a cloud client only.",
    );
  }
  console.info(`[runtime] starting in cloud mode -> ${cloudApiBaseUrl}`);
  const runtime = createCloudRuntime(cloudApiBaseUrl);

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
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.getDeviceAnalytics, (_event, input) =>
    runtime.getDeviceAnalytics(input),
  );
  ipcMain.handle(DESKTOP_RUNTIME_CHANNELS.getDeviceActivity, (_event, deviceId, limit) =>
    runtime.getDeviceActivity(deviceId, limit),
  );

  void runtime.start().catch((error) => {
    console.error("[runtime] failed to start cloud runtime", error);
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
      ipcMain.removeHandler(DESKTOP_RUNTIME_CHANNELS.getDeviceActivity);
    },
  };
}
