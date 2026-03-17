import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { useDesktopApp } from "./runtime/use-desktop-app";
import { isDesktopRuntimeLoaded } from "./runtime/state";

type DesktopRuntimeValue = ReturnType<typeof useDesktopApp> & {
  isLoaded: boolean;
};

const DesktopRuntimeContext = createContext<DesktopRuntimeValue | null>(null);

export function DesktopRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const desktopApp = useDesktopApp();

  return (
    <DesktopRuntimeContext.Provider
      value={{
        ...desktopApp,
        isLoaded: isDesktopRuntimeLoaded(desktopApp),
      }}
    >
      {children}
    </DesktopRuntimeContext.Provider>
  );
}

export function useDesktopRuntime() {
  const context = useContext(DesktopRuntimeContext);

  if (!context) {
    throw new Error("useDesktopRuntime must be used within DesktopRuntimeProvider.");
  }

  return context;
}
