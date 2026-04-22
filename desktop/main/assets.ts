import path from "node:path";

import { nativeImage } from "electron";

const DESKTOP_ICON_PATH = path.join(__dirname, "../../desktop/resources/icon.png");
const DESKTOP_SMALL_ICON_PATH = path.join(__dirname, "../../desktop/resources/icon-small.png");

export function getDesktopIconPath() {
  return DESKTOP_ICON_PATH;
}

export function createDesktopIcon() {
  return nativeImage.createFromPath(DESKTOP_ICON_PATH);
}

export function createTrayIcon() {
  return nativeImage.createFromPath(DESKTOP_SMALL_ICON_PATH);
}
