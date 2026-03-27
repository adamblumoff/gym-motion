import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { useDesktopApp } from "./runtime/use-desktop-app";
import { isDesktopRuntimeLoaded } from "./runtime/state";

type DesktopRuntimeValue = ReturnType<typeof useDesktopApp>;

const DesktopRuntimeContext = createContext<DesktopRuntimeValue | null>(null);
const DesktopRuntimeLoadedContext = createContext(false);

export function DesktopRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const desktopApp = useDesktopApp();
  const isLoaded = useMemo(
    () => isDesktopRuntimeLoaded(desktopApp),
    [desktopApp.setup, desktopApp.snapshot],
  );

  return (
    <DesktopRuntimeLoadedContext.Provider value={isLoaded}>
      <DesktopRuntimeContext.Provider value={desktopApp}>
        {children}
      </DesktopRuntimeContext.Provider>
    </DesktopRuntimeLoadedContext.Provider>
  );
}

export function useDesktopRuntime() {
  const context = useContext(DesktopRuntimeContext);

  if (!context) {
    throw new Error("useDesktopRuntime must be used within DesktopRuntimeProvider.");
  }

  return context;
}

export function useDesktopRuntimeLoaded() {
  return useContext(DesktopRuntimeLoadedContext);
}
