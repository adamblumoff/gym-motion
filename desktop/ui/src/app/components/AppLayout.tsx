import { useEffect } from "react";
import { Outlet } from "react-router";

import { preloadSecondaryRoutes } from "../route-modules";
import { DesktopCornerBrand } from "./DesktopCornerBrand";
import { SidebarProvider } from "./sidebar/SidebarContext";
import { AppSidebar } from "./sidebar/AppSidebar";

export function AppLayout() {
  useEffect(() => {
    const warmRoutes = () => {
      void preloadSecondaryRoutes();
    };

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(warmRoutes, { timeout: 400 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = window.setTimeout(warmRoutes, 150);
    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <SidebarProvider>
      <div className="relative h-screen w-full overflow-hidden bg-[var(--desktop-shell-bg)] pt-[44px]">
        <DesktopCornerBrand />
        <div className="flex h-full min-h-0 overflow-hidden">
          <AppSidebar />
          <main className="flex-1 min-w-0 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
