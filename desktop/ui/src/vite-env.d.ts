import type { DesktopApi } from "@core/services";

declare global {
  interface Window {
    gymMotionDesktop: DesktopApi;
  }
}

export {};
