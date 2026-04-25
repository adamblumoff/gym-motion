import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { GatewayAdminGateway } from "@core/services";

import {
  DEFAULT_PORT,
  DEFAULT_REPO_PATH,
  DEFAULT_SERVICE_NAME,
} from "./gateway-admin-utils";
import { cn } from "../ui/utils";

const inputClassName =
  "h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500";
const monoInputClassName = cn(inputClassName, "font-mono");

function TextField({
  label,
  value,
  placeholder,
  className = inputClassName,
  fullWidth,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  className?: string;
  fullWidth?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={cn("space-y-2 text-sm", fullWidth && "md:col-span-2")}>
      <span className="text-zinc-400">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={className}
        placeholder={placeholder}
      />
    </label>
  );
}

export function FieldRow({
  icon: Icon,
  label,
  value,
  onCopy,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-zinc-800/80 py-3.5 last:border-b-0">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400">
        <Icon className="size-3.5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-zinc-400">{label}</div>
      </div>
      <div className="min-w-0 max-w-[50%] truncate text-right text-[13px] text-blue-400 tabular-nums">
        {value}
      </div>
      {onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md p-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          <Copy className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function QuickActionButton({
  icon: Icon,
  title,
  disabled,
  onClick,
  variant = "secondary",
}: {
  icon: LucideIcon;
  title: string;
  disabled: boolean;
  onClick: () => void;
  variant?: "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition disabled:opacity-40",
        variant === "primary"
          ? "bg-blue-600 text-white hover:bg-blue-500"
          : "border border-zinc-800 bg-transparent text-zinc-100 hover:bg-white/5",
      )}
    >
      <Icon
        className={cn("size-4", variant === "primary" ? "text-white" : "text-blue-400")}
        aria-hidden="true"
      />
      {title}
    </button>
  );
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={cn("border-t border-zinc-800 pt-5", className)}>{children}</section>;
}

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium",
        tone === "good" && "bg-emerald-500/15 text-emerald-300",
        tone === "warning" && "bg-amber-500/15 text-amber-300",
        tone === "neutral" && "bg-zinc-800 text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

export function GatewayFieldGroup({
  gateway,
  onChange,
}: {
  gateway: GatewayAdminGateway;
  onChange: <TKey extends keyof GatewayAdminGateway>(
    field: TKey,
    value: GatewayAdminGateway[TKey],
  ) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TextField
        label="Label"
        value={gateway.label}
        placeholder="Zone A Gateway"
        onChange={(value) => onChange("label", value)}
      />
      <TextField
        label="Host"
        value={gateway.host ?? ""}
        placeholder="192.168.1.174"
        className={monoInputClassName}
        onChange={(value) => onChange("host", value || null)}
      />
      <TextField
        label="User"
        value={gateway.user ?? ""}
        placeholder="adam-blumoff"
        className={monoInputClassName}
        onChange={(value) => onChange("user", value || null)}
      />
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">Port</span>
        <input
          value={String(gateway.port)}
          onChange={(event) => {
            const nextPort = Number(event.target.value);
            if (Number.isFinite(nextPort)) {
              onChange("port", nextPort);
            }
          }}
          className={monoInputClassName}
          placeholder={String(DEFAULT_PORT)}
        />
      </label>
      <TextField
        label="Service Name"
        value={gateway.serviceName}
        placeholder={DEFAULT_SERVICE_NAME}
        className={monoInputClassName}
        onChange={(value) => onChange("serviceName", value)}
      />
      <TextField
        label="SSH Alias Fallback"
        value={gateway.sshHostAlias ?? ""}
        placeholder="Optional"
        className={monoInputClassName}
        onChange={(value) => onChange("sshHostAlias", value || null)}
      />
      <TextField
        label="Repo Path"
        value={gateway.repoPath}
        placeholder={DEFAULT_REPO_PATH}
        className={monoInputClassName}
        fullWidth
        onChange={(value) => onChange("repoPath", value)}
      />
      <label className="space-y-2 text-sm md:col-span-2">
        <span className="text-zinc-400">Notes</span>
        <textarea
          value={gateway.notes ?? ""}
          onChange={(event) => onChange("notes", event.target.value || null)}
          maxLength={200}
          className={cn(inputClassName, "min-h-24 py-3")}
          placeholder="Optional notes about this gateway..."
        />
        <div className="text-right text-xs text-zinc-500">{(gateway.notes ?? "").length} / 200</div>
      </label>
    </div>
  );
}
