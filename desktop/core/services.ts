import type { DesktopEnvironment, DesktopSnapshot } from "./contracts";

export const DESKTOP_RUNTIME_CHANNELS = {
  getSnapshot: "runtime:get-snapshot",
  triggerDemoBurst: "runtime:trigger-demo-burst",
  setEnvironment: "runtime:set-environment",
  updated: "runtime:updated",
} as const;

export type DesktopRuntimeEvent = {
  snapshot: DesktopSnapshot;
};

export type DesktopApi = {
  getSnapshot: () => Promise<DesktopSnapshot>;
  triggerDemoBurst: () => Promise<void>;
  setEnvironment: (environment: DesktopEnvironment) => Promise<DesktopSnapshot>;
  subscribe: (listener: (event: DesktopRuntimeEvent) => void) => () => void;
};
