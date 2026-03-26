import type { MouseEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router";

type SidebarNavItemProps = {
  icon: LucideIcon;
  label: string;
  to: string;
  collapsed: boolean;
};

export function SidebarNavItem({ icon: Icon, label, to, collapsed }: SidebarNavItemProps) {
  const { pathname } = useLocation();
  const isActive = to === "/" ? pathname === "/" : pathname.startsWith(to);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (to !== "/" || pathname === "/") {
      return;
    }

    event.preventDefault();
    window.location.hash = "#/";
    window.location.reload();
  }

  return (
    <Link
      to={to}
      onClick={handleClick}
      title={collapsed ? label : undefined}
      className={[
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150",
        collapsed ? "justify-center" : "",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      ].join(" ")}
    >
      <Icon className="size-5 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
