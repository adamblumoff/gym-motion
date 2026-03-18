import type { DesktopApi, DesktopTestApi } from "@core/services";

declare global {
  interface Window {
    gymMotionDesktop: DesktopApi;
    gymMotionDesktopTest?: DesktopTestApi;
  }
}

export {};
