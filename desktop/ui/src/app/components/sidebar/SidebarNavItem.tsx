import type { LucideIcon } from "lucide-react";
import { NavLink } from "react-router";

import { preloadRouteForPath } from "../../route-modules";

type SidebarNavItemProps = {
  icon: LucideIcon;
  label: string;
  to: string;
  collapsed: boolean;
};

export function SidebarNavItem({ icon: Icon, label, to, collapsed }: SidebarNavItemProps) {
  function warmRouteModule() {
    void preloadRouteForPath(to);
  }

  return (
    <NavLink
      to={to}
      end={to === "/"}
      title={collapsed ? label : undefined}
      onFocus={warmRouteModule}
      onMouseEnter={warmRouteModule}
      className={({ isActive }) => [
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150",
        collapsed ? "justify-center" : "",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      ].join(" ")}
    >
      <Icon className="size-5 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}
