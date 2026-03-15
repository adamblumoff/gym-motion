import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { useDesktopApp } from "../lib/use-desktop-app";

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
        isLoaded: desktopApp.snapshot !== null && desktopApp.setup !== null,
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
