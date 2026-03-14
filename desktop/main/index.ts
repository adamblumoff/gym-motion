import path from "node:path";
import { Buffer } from "node:buffer";

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  shell,
} from "electron";

import { DESKTOP_THEME_CHANNELS } from "@core/services";
import { registerRuntimeBridge } from "./runtime";
import { createPreferencesStore } from "./preferences-store";
import { createThemeController } from "./theme";
import { loadDesktopEnv } from "./load-env";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let runtimeBridge: ReturnType<typeof registerRuntimeBridge> | null = null;
let themeBridgeDisposer: (() => void) | null = null;

function createTrayImage() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="18" fill="#0d2029"/>
      <path d="M18 45V20h8l6 13 6-13h8v25h-6V31l-6 12h-4l-6-12v14z" fill="#f6a55f"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
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
    backgroundColor: "#08131a",
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
  const nextTray = new Tray(createTrayImage());

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
    const themeController = createThemeController(preferences);
    const broadcastThemeState = (themeState: ReturnType<typeof themeController.getState>) => {
      const backgroundColor = themeState.resolvedTheme === "dark" ? "#050506" : "#f4f4f0";

      mainWindow?.setBackgroundColor(backgroundColor);

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
    tray = createTray();
    runtimeBridge = registerRuntimeBridge(() => (mainWindow ? [mainWindow] : []), preferences);

    app.on("activate", () => {
      showMainWindow();
    });
  });
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("quit", () => {
  runtimeBridge?.dispose();
  themeBridgeDisposer?.();
  ipcMain.removeHandler(DESKTOP_THEME_CHANNELS.getState);
  ipcMain.removeHandler(DESKTOP_THEME_CHANNELS.setPreference);
  tray?.destroy();
});
