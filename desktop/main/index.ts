import path from "node:path";

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  shell,
} from "electron";

import { getDesktopShellPalette } from "@core/contracts";
import { DESKTOP_THEME_CHANNELS } from "@core/services";
import { createDesktopIcon, createTrayIcon, getDesktopIconPath } from "./assets";
import { registerGatewayAdminBridge } from "./gateway-admin";
import { createGatewayAdminStore } from "./gateway-admin-store";
import { registerRuntimeBridge } from "./runtime";
import { createPreferencesStore } from "./preferences-store";
import { createThemeController } from "./theme";
import { loadDesktopEnv } from "./load-env";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let isDisposingRuntime = false;
let runtimeBridge: ReturnType<typeof registerRuntimeBridge> | null = null;
let gatewayAdminBridge: ReturnType<typeof registerGatewayAdminBridge> | null = null;
let themeBridgeDisposer: (() => void) | null = null;
const DEFAULT_DESKTOP_SHELL = getDesktopShellPalette("dark");

function syncTitleBarOverlay(resolvedTheme: "light" | "dark") {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform === "darwin") {
    return;
  }

  const desktopShellPalette = getDesktopShellPalette(resolvedTheme);

  mainWindow.setTitleBarOverlay({
    color: desktopShellPalette.shellBackground,
    symbolColor: desktopShellPalette.titleBarSymbol,
    height: 44,
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: "Gym Motion",
    autoHideMenuBar: true,
    backgroundColor: DEFAULT_DESKTOP_SHELL.windowBackground,
    icon: getDesktopIconPath(),
    titleBarStyle: process.platform === "darwin" ? "default" : "hidden",
    ...(process.platform === "darwin"
      ? {}
      : {
          titleBarOverlay: {
            color: DEFAULT_DESKTOP_SHELL.shellBackground,
            symbolColor: DEFAULT_DESKTOP_SHELL.titleBarSymbol,
            height: 44,
          },
        }),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.on("ready-to-show", () => {
    window.show();
  });

  window.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    if (!app.isPackaged) {
      isQuitting = true;
      app.quit();
      return;
    }

    event.preventDefault();
    window.hide();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return window;
}

function showMainWindow() {
  if (!mainWindow) {
    mainWindow = createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const nextTray = new Tray(createTrayIcon());

  nextTray.setToolTip("Gym Motion");
  nextTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Gym Motion",
        click: () => showMainWindow(),
      },
      {
        type: "separator",
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );

  nextTray.on("click", () => {
    showMainWindow();
  });

  return nextTray;
}

const singleInstance = app.requestSingleInstanceLock();

try {
  const envResult = loadDesktopEnv();

  if (envResult.loadedFiles.length > 0) {
    console.info(
      `[env] loaded ${envResult.loadedFiles.length} env file${envResult.loadedFiles.length === 1 ? "" : "s"}`,
    );
  } else {
    console.warn("[env] no .env or .env.local file found for desktop runtime");
  }
} catch (error) {
  console.error("[env] failed to load desktop env files", error);
}

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId("com.gymmotion.desktop");
    const preferences = createPreferencesStore();
    const gatewayAdminStore = createGatewayAdminStore();
    const themeController = createThemeController(preferences);
    const broadcastThemeState = (themeState: ReturnType<typeof themeController.getState>) => {
      const desktopShellPalette = getDesktopShellPalette(themeState.resolvedTheme);

      mainWindow?.setBackgroundColor(desktopShellPalette.windowBackground);
      syncTitleBarOverlay(themeState.resolvedTheme);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(DESKTOP_THEME_CHANNELS.updated, themeState);
      }
    };

    ipcMain.handle(DESKTOP_THEME_CHANNELS.getState, () => themeController.getState());
    ipcMain.handle(DESKTOP_THEME_CHANNELS.setPreference, (_event, preference) => {
      const themeState = themeController.setPreference(preference);
      broadcastThemeState(themeState);
      return themeState;
    });
    themeBridgeDisposer = themeController.subscribe((themeState) => {
      broadcastThemeState(themeState);
    });
    themeController.getState();

    mainWindow = createWindow();
    app.dock?.setIcon?.(createDesktopIcon());
    tray = createTray();
    runtimeBridge = registerRuntimeBridge(() => (mainWindow ? [mainWindow] : []));
    gatewayAdminBridge = registerGatewayAdminBridge(gatewayAdminStore);

    app.on("activate", () => {
      showMainWindow();
    });
  });
}

app.on("before-quit", (event) => {
  if (isDisposingRuntime) {
    return;
  }

  event.preventDefault();
  isQuitting = true;
  isDisposingRuntime = true;

  void (async () => {
    try {
      await runtimeBridge?.dispose();
    } catch (error) {
      console.error("[runtime] failed to dispose cloud runtime", error);
    } finally {
      runtimeBridge = null;
      gatewayAdminBridge?.dispose();
      gatewayAdminBridge = null;
      themeBridgeDisposer?.();
      themeBridgeDisposer = null;
      ipcMain.removeHandler(DESKTOP_THEME_CHANNELS.getState);
      ipcMain.removeHandler(DESKTOP_THEME_CHANNELS.setPreference);
      tray?.destroy();
      tray = null;
      mainWindow = null;
      app.quit();
    }
  })();
});

app.on("quit", () => {
  isDisposingRuntime = true;
});
