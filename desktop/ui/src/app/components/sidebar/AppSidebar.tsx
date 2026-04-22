import { ArrowLeftFromLine, ArrowRightFromLine, BarChart3, Bluetooth, LayoutDashboard, Settings } from "lucide-react";

import { useSidebar } from "./SidebarContext";
import { SidebarNavItem } from "./SidebarNavItem";

export function AppSidebar() {
  const { collapsed, toggle } = useSidebar();

  return (
    <aside
      className={[
        "flex flex-col h-full shrink-0 overflow-hidden border-r border-[var(--desktop-shell-border)] bg-[var(--desktop-shell-bg)]",
        collapsed ? "w-16" : "w-60",
      ].join(" ")}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 border-b border-[var(--desktop-shell-border)] px-4 py-4">
        <div className="p-2 bg-blue-500/10 rounded-lg shrink-0">
          <Bluetooth className="size-5 text-blue-400" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-sidebar-foreground truncate">Motion Tracking</h1>
            <p className="text-xs text-sidebar-foreground/50 truncate">Accelerometer monitor</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-1 px-3 py-4">
        <SidebarNavItem icon={LayoutDashboard} label="Dashboard" to="/" collapsed={collapsed} />
        <SidebarNavItem icon={Settings} label="Gateway Admin" to="/setup" collapsed={collapsed} />
        <SidebarNavItem icon={BarChart3} label="Analytics" to="/analytics" collapsed={collapsed} />
      </nav>

      {/* Collapse / expand toggle */}
      <div className="border-t border-[var(--desktop-shell-border)] px-3 py-3">
        <button
          type="button"
          onClick={toggle}
          className={[
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors duration-150 w-full",
            collapsed ? "justify-center" : "",
          ].join(" ")}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed
            ? <ArrowRightFromLine className="size-4 shrink-0" />
            : <ArrowLeftFromLine className="size-4 shrink-0" />
          }
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
