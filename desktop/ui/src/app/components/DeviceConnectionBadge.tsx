import { Bluetooth, Check, RefreshCw } from "lucide-react";

import type { GatewayConnectionState } from "@core/contracts";

import { Badge } from "./ui/badge";

type DisplayConnectionState = GatewayConnectionState | "visible";

type DeviceConnectionBadgeProps = {
  state: DisplayConnectionState;
  className?: string;
};

function connectionBadge(state: DisplayConnectionState) {
  switch (state) {
    case "connected":
      return {
        label: "Connected",
        className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
        icon: Check,
      };
    case "connecting":
    case "reconnecting":
      return {
        label: "Reconnecting",
        className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
        icon: RefreshCw,
      };
    case "visible":
      return {
        label: "Visible",
        className: "bg-zinc-800 text-zinc-300 border-zinc-700",
        icon: Bluetooth,
      };
    default:
      return {
        label: "Disconnected",
        className: "bg-red-500/10 text-red-400 border-red-500/20",
        icon: Bluetooth,
      };
  }
}

export function DeviceConnectionBadge({
  state,
  className = "",
}: DeviceConnectionBadgeProps) {
  const badge = connectionBadge(state);
  const Icon = badge.icon;

  return (
    <Badge className={`${badge.className} ${className}`.trim()}>
      <Icon
        className={`size-3 mr-1 ${badge.label === "Reconnecting" ? "animate-spin" : ""}`}
      />
      {badge.label}
    </Badge>
  );
}
