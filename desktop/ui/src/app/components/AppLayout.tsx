import { Outlet } from "react-router";

import { SidebarProvider } from "./sidebar/SidebarContext";
import { AppSidebar } from "./sidebar/AppSidebar";

export function AppLayout() {
  return (
    <SidebarProvider>
      <div className="size-full flex bg-black">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-auto">
          <Outlet />
        </main>
      </div>
    </SidebarProvider>
  );
}
