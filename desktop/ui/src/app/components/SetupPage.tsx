import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  FolderOpen,
  HardDrive,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

import type {
  GatewayAdminCommand,
  GatewayAdminCommandResult,
  GatewayAdminConfig,
  GatewayAdminGateway,
  GatewayAdminReadinessResult,
} from "@core/services";

import { ConfirmationDialog } from "./ConfirmationDialog";
import { Button } from "./ui/button";
import { cn } from "./ui/utils";

const DEFAULT_SERVICE_NAME = "gym-motion-linux-gateway.service";
const DEFAULT_PORT = 22;
const DEFAULT_REPO_PATH = "~/gym-motion";

function createGatewayDraft(): GatewayAdminGateway {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `gateway-${Date.now()}`,
    label: "New Gateway",
    sshHostAlias: null,
    host: "",
    user: "",
    port: DEFAULT_PORT,
    serviceName: DEFAULT_SERVICE_NAME,
    repoPath: DEFAULT_REPO_PATH,
    notes: null,
  };
}

function cloneGateway(gateway: GatewayAdminGateway | null) {
  return gateway ? { ...gateway } : null;
}

function isGatewayValid(gateway: GatewayAdminGateway | null) {
  if (!gateway) {
    return false;
  }

  return (
    !!gateway.label.trim() &&
    !!((gateway.host?.trim() && gateway.user?.trim()) || gateway.sshHostAlias?.trim())
  );
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "never";
  }

  return new Date(value).toLocaleString();
}

function buildCommandTitle(command: GatewayAdminCommand) {
  switch (command) {
    case "status":
      return "Status";
    case "start":
      return "Start";
    case "stop":
      return "Stop";
    case "restart":
      return "Restart";
    case "logs":
      return "Logs";
    case "custom":
      return "Custom Command";
  }
}

function buildBootstrapCommand(gateway: GatewayAdminGateway | null) {
  const repoPath = gateway?.repoPath?.trim() || DEFAULT_REPO_PATH;
  return `cd ${repoPath} && bash ./scripts/linux-gateway/bootstrap-admin.sh`;
}

function buildConnectionLabel(gateway: GatewayAdminGateway) {
  if (gateway.host && gateway.user) {
    return `${gateway.user}@${gateway.host}:${gateway.port}`;
  }

  return gateway.sshHostAlias || "connection not set";
}

function buildSshPreview(gateway: GatewayAdminGateway | null) {
  if (!gateway) {
    return "Save a gateway to preview the SSH command.";
  }

  if (gateway.host && gateway.user) {
    return [
      `ssh -p ${gateway.port} ${gateway.user}@${gateway.host} \\`,
      "  -o StrictHostKeyChecking=accept-new \\",
      "  -o IdentitiesOnly=yes",
    ].join("\n");
  }

  if (gateway.sshHostAlias) {
    return [
      `ssh ${gateway.sshHostAlias} \\`,
      "  -o StrictHostKeyChecking=accept-new \\",
      "  -o IdentitiesOnly=yes",
    ].join("\n");
  }

  return "Fill in host and user, or provide an SSH alias fallback.";
}

function FieldRow({
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

function QuickActionButton({
  icon: Icon,
  title,
  subtitle,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex min-h-24 flex-col justify-between rounded-lg border border-zinc-800 bg-zinc-950/55 p-3 text-left transition hover:border-zinc-700 hover:bg-zinc-900/80 disabled:opacity-40 disabled:hover:border-zinc-800 disabled:hover:bg-zinc-950/55"
    >
      <div className="flex items-center gap-2.5 text-zinc-100">
        <Icon className="size-4 text-blue-400" aria-hidden="true" />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <div className="text-xs leading-5 text-zinc-500 group-hover:text-zinc-400">{subtitle}</div>
    </button>
  );
}

function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-zinc-800 bg-zinc-950/70", className)}>
      {children}
    </section>
  );
}

function StatusPill({
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

function GatewayFieldGroup({
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
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">Label</span>
        <input
          value={gateway.label}
          onChange={(event) => onChange("label", event.target.value)}
          className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder="Zone A Gateway"
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">Host</span>
        <input
          value={gateway.host ?? ""}
          onChange={(event) => onChange("host", event.target.value || null)}
          className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder="192.168.1.174"
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">User</span>
        <input
          value={gateway.user ?? ""}
          onChange={(event) => onChange("user", event.target.value || null)}
          className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder="adam-blumoff"
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">Port</span>
        <input
          value={String(gateway.port)}
          onChange={(event) => {
            const nextPort = Number(event.target.value);
            if (!Number.isFinite(nextPort)) {
              return;
            }
            onChange("port", nextPort);
          }}
          className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder={String(DEFAULT_PORT)}
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">Service Name</span>
        <input
          value={gateway.serviceName}
          onChange={(event) => onChange("serviceName", event.target.value)}
          className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder={DEFAULT_SERVICE_NAME}
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">SSH Alias Fallback</span>
        <input
          value={gateway.sshHostAlias ?? ""}
          onChange={(event) => onChange("sshHostAlias", event.target.value || null)}
          className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder="Optional"
        />
      </label>
      <label className="space-y-2 text-sm md:col-span-2">
        <span className="text-zinc-400">Repo Path</span>
        <input
          value={gateway.repoPath}
          onChange={(event) => onChange("repoPath", event.target.value)}
          className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder={DEFAULT_REPO_PATH}
        />
      </label>
      <label className="space-y-2 text-sm md:col-span-2">
        <span className="text-zinc-400">Notes</span>
        <textarea
          value={gateway.notes ?? ""}
          onChange={(event) => onChange("notes", event.target.value || null)}
          maxLength={200}
          className="min-h-24 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
          placeholder="Optional notes about this gateway..."
        />
        <div className="text-right text-xs text-zinc-500">{(gateway.notes ?? "").length} / 200</div>
      </label>
    </div>
  );
}

type EditorMode = "edit" | "create";

export function SetupPage() {
  const [config, setConfig] = useState<GatewayAdminConfig | null>(null);
  const [selectedGatewayId, setSelectedGatewayId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");
  const [editorGateway, setEditorGateway] = useState<GatewayAdminGateway | null>(null);
  const [returnGatewayId, setReturnGatewayId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastResult, setLastResult] = useState<GatewayAdminCommandResult | null>(null);
  const [readiness, setReadiness] = useState<GatewayAdminReadinessResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingGatewayId, setDeletingGatewayId] = useState<string | null>(null);
  const [pendingDeleteGatewayId, setPendingDeleteGatewayId] = useState<string | null>(null);
  const [runningCommand, setRunningCommand] = useState<GatewayAdminCommand | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);

  const persistedSelectedGateway = useMemo(
    () => config?.gateways.find((gateway) => gateway.id === selectedGatewayId) ?? null,
    [config, selectedGatewayId],
  );

  useEffect(() => {
    let mounted = true;

    void window.gymMotionDesktop
      .getGatewayAdminConfig()
      .then((nextConfig) => {
        if (!mounted) {
          return;
        }

        const firstGateway = nextConfig.gateways[0] ?? null;
        setConfig(nextConfig);
        setSelectedGatewayId(firstGateway?.id ?? null);
        setEditorMode("edit");
        setEditorGateway(cloneGateway(firstGateway));
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "Failed to load gateway config.");
      });

    return () => {
      mounted = false;
    };
  }, []);

  const filteredGateways = useMemo(() => {
    const gateways = config?.gateways ?? [];
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return gateways;
    }

    return gateways.filter((gateway) =>
      [gateway.label, gateway.host, gateway.user, gateway.sshHostAlias]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(query)),
    );
  }, [config?.gateways, searchQuery]);

  const isCreateMode = editorMode === "create";
  const activeGateway = editorGateway;
  const editorDirty = useMemo(() => {
    if (!editorGateway) {
      return false;
    }

    if (editorMode === "create") {
      return true;
    }

    if (!persistedSelectedGateway) {
      return false;
    }

    return JSON.stringify(editorGateway) !== JSON.stringify(persistedSelectedGateway);
  }, [editorGateway, editorMode, persistedSelectedGateway]);

  const canSaveGateway =
    !!editorGateway && isGatewayValid(editorGateway) && (editorMode === "create" || editorDirty);

  useEffect(() => {
    if (editorMode === "create") {
      setReadiness(null);
      return;
    }

    if (!persistedSelectedGateway) {
      setReadiness(null);
      if (config && config.gateways.length > 0 && selectedGatewayId === null) {
        const firstGateway = config.gateways[0] ?? null;
        setSelectedGatewayId(firstGateway?.id ?? null);
        setEditorGateway(cloneGateway(firstGateway));
      }
      return;
    }

    setEditorGateway((current) => {
      if (!current || current.id !== persistedSelectedGateway.id || !editorDirty) {
        return cloneGateway(persistedSelectedGateway);
      }

      return current;
    });
  }, [config, editorDirty, editorMode, persistedSelectedGateway, selectedGatewayId]);

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}.`);
    }
  }

  function patchGatewayField<TKey extends keyof GatewayAdminGateway>(
    field: TKey,
    value: GatewayAdminGateway[TKey],
  ) {
    setEditorGateway((current) => (current ? { ...current, [field]: value } : current));
  }

  function syncFromConfig(nextConfig: GatewayAdminConfig, nextSelectedId: string | null) {
    const nextSelectedGateway =
      nextSelectedId !== null
        ? nextConfig.gateways.find((gateway) => gateway.id === nextSelectedId) ?? null
        : null;
    setConfig(nextConfig);
    setSelectedGatewayId(nextSelectedGateway?.id ?? null);
    setEditorMode("edit");
    setEditorGateway(cloneGateway(nextSelectedGateway));
    setReturnGatewayId(null);
  }

  function startCreateGateway() {
    if (isCreateMode) {
      return;
    }

    if (editorDirty) {
      toast.error("Save or cancel the current gateway changes first.");
      return;
    }

    setReturnGatewayId(selectedGatewayId);
    setEditorMode("create");
    setEditorGateway(createGatewayDraft());
    setReadiness(null);
  }

  function selectGateway(gatewayId: string) {
    const nextGateway = config?.gateways.find((gateway) => gateway.id === gatewayId) ?? null;
    if (!nextGateway) {
      return;
    }

    if (isCreateMode || editorDirty) {
      toast.error("Save or cancel the current gateway changes first.");
      return;
    }

    setSelectedGatewayId(nextGateway.id);
    setEditorMode("edit");
    setEditorGateway(cloneGateway(nextGateway));
    if (readiness?.gatewayId !== nextGateway.id) {
      setReadiness(null);
    }
  }

  function cancelEditing() {
    if (editorMode === "create") {
      const nextSelectedId = returnGatewayId ?? config?.gateways[0]?.id ?? null;
      const nextGateway =
        nextSelectedId !== null
          ? config?.gateways.find((gateway) => gateway.id === nextSelectedId) ?? null
          : null;
      setSelectedGatewayId(nextSelectedId);
      setEditorMode("edit");
      setEditorGateway(cloneGateway(nextGateway));
      setReturnGatewayId(null);
      setReadiness(null);
      return;
    }

    setEditorGateway(cloneGateway(persistedSelectedGateway));
  }

  async function saveGateway() {
    if (!config || !editorGateway || !canSaveGateway) {
      return;
    }

    setIsSaving(true);

    try {
      const nextConfig =
        editorMode === "create"
          ? { gateways: [...config.gateways, editorGateway] }
          : {
              gateways: config.gateways.map((gateway) =>
                gateway.id === editorGateway.id ? editorGateway : gateway,
              ),
            };

      const saved = await window.gymMotionDesktop.saveGatewayAdminConfig(nextConfig);
      syncFromConfig(saved, editorGateway.id);
      setLastResult(null);
      setReadiness(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save gateway config.");
    } finally {
      setIsSaving(false);
    }
  }

  function requestDeleteGateway(gatewayId: string) {
    if (isCreateMode || editorDirty) {
      toast.error("Save or cancel the current gateway changes first.");
      return;
    }

    setPendingDeleteGatewayId(gatewayId);
  }

  async function confirmDeleteGateway() {
    if (!config || !pendingDeleteGatewayId) {
      return;
    }

    setDeletingGatewayId(pendingDeleteGatewayId);

    try {
      const nextGateways = config.gateways.filter((gateway) => gateway.id !== pendingDeleteGatewayId);
      const nextConfig = { gateways: nextGateways };
      const saved = await window.gymMotionDesktop.saveGatewayAdminConfig(nextConfig);
      const nextSelectedId =
        selectedGatewayId === pendingDeleteGatewayId
          ? saved.gateways[0]?.id ?? null
          : selectedGatewayId;
      syncFromConfig(saved, nextSelectedId);
      if (lastResult?.gatewayId === pendingDeleteGatewayId) {
        setLastResult(null);
      }
      if (readiness?.gatewayId === pendingDeleteGatewayId) {
        setReadiness(null);
      }
      setPendingDeleteGatewayId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete gateway.");
    } finally {
      setDeletingGatewayId(null);
    }
  }

  async function runCommand(command: GatewayAdminCommand) {
    if (!persistedSelectedGateway) {
      toast.error("Save the gateway before running commands.");
      return;
    }

    setRunningCommand(command);

    try {
      const result = await window.gymMotionDesktop.runGatewayAdminCommand({
        gatewayId: persistedSelectedGateway.id,
        command,
        customCommand: "",
      });
      setLastResult(result);
      toast.success(
        result.ok ? `${buildCommandTitle(command)} finished.` : `${buildCommandTitle(command)} failed.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to run remote command.");
    } finally {
      setRunningCommand(null);
    }
  }

  async function runReadinessCheck() {
    if (!persistedSelectedGateway) {
      toast.error("Save the gateway before checking readiness.");
      return;
    }

    setCheckingReadiness(true);

    try {
      const nextReadiness = await window.gymMotionDesktop.checkGatewayAdminReadiness(
        persistedSelectedGateway.id,
      );
      setReadiness(nextReadiness);
      toast.success(
        nextReadiness.overallOk
          ? "Gateway admin is ready."
          : "Gateway admin still needs a couple setup steps.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to check readiness.");
    } finally {
      setCheckingReadiness(false);
    }
  }

  const sshPreview = buildSshPreview(activeGateway);
  const bootstrapCommand = buildBootstrapCommand(activeGateway);
  const saveStatusLabel = isCreateMode ? "New gateway" : editorDirty ? "Unsaved changes" : activeGateway ? "Saved" : null;
  const saveStatusTone = isCreateMode || editorDirty ? "text-amber-300" : "text-zinc-500";
  const selectedConnectionLabel = activeGateway ? buildConnectionLabel(activeGateway) : "No gateway selected";
  const lastUpdatedLabel = readiness?.checkedAt ?? lastResult?.finishedAt ?? null;
  const gatewayStatusTone = isCreateMode
    ? "warning"
    : readiness?.overallOk
      ? "good"
      : "neutral";
  const gatewayStatusLabel = isCreateMode
    ? "Draft"
    : readiness
      ? readiness.overallOk
        ? "Active"
        : "Needs setup"
      : "Unverified";

  return (
    <div className="flex-1 overflow-auto bg-black">
      <div className="min-h-full">
        <header className="border-b border-zinc-800 bg-zinc-950/35 px-6 py-6">
          <div className="mx-auto flex max-w-[1500px] flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <h1 className="text-balance text-[2rem] font-semibold text-zinc-50">Gateway Admin</h1>
              <p className="mt-2 max-w-xl text-pretty text-sm text-zinc-400">
                Manage Linux gateways over SSH from this desktop app.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {saveStatusLabel ? (
                <div className={cn("text-sm", saveStatusTone)}>{saveStatusLabel}</div>
              ) : null}
              <Button
                variant="outline"
                className="h-10 rounded-lg border-zinc-800 bg-zinc-950 px-4 text-sm text-zinc-100 hover:bg-zinc-900"
                onClick={startCreateGateway}
                disabled={isSaving || deletingGatewayId !== null}
              >
                <Plus className="size-4" aria-hidden="true" />
                Add Gateway
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-lg border-zinc-800 bg-zinc-950 px-4 text-sm text-zinc-100 hover:bg-zinc-900"
                onClick={() => void runReadinessCheck()}
                disabled={!persistedSelectedGateway || checkingReadiness || isSaving}
              >
                <ShieldCheck className="size-4" aria-hidden="true" />
                {checkingReadiness ? "Checking..." : "Check Readiness"}
              </Button>
              {(isCreateMode || editorDirty) && (
                <Button
                  variant="outline"
                  className="h-10 rounded-lg border-zinc-800 bg-zinc-950 px-4 text-sm text-zinc-100 hover:bg-zinc-900"
                  onClick={cancelEditing}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              )}
              <Button
                className="h-10 rounded-lg bg-blue-600 px-4 text-sm text-white hover:bg-blue-500"
                onClick={() => void saveGateway()}
                disabled={!canSaveGateway || isSaving}
              >
                <CheckCircle2 className="size-4" aria-hidden="true" />
                {isSaving ? "Saving..." : "Save Gateway"}
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto grid max-w-[1500px] gap-0 px-6 xl:grid-cols-[260px_minmax(420px,1fr)_400px]">
          <aside className="border-b border-zinc-800 py-5 xl:min-h-[calc(100dvh-105px)] xl:border-b-0 xl:border-r xl:pr-5">
            <div className="flex h-full flex-col gap-4">
              <div className="text-xs font-semibold uppercase text-zinc-500">Gateways</div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search gateways..."
                  className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-blue-500"
                />
              </div>

              <div className="space-y-3">
                {isCreateMode && activeGateway ? (
                  <div className="rounded-lg border border-blue-500 bg-blue-500/10 p-3.5">
                    <div className="flex min-w-0 gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400">
                        <HardDrive className="size-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-100">
                          {activeGateway.label || "New Gateway"}
                        </div>
                        <div className="mt-1 truncate text-xs text-blue-400">
                          {buildConnectionLabel(activeGateway)}
                        </div>
                        <div className="mt-3">
                          <StatusPill tone="warning">Draft</StatusPill>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {filteredGateways.length === 0 ? (
                  <div className="space-y-4 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/70 p-4 text-sm text-zinc-500">
                    <p>No gateways yet.</p>
                    <Button
                      variant="outline"
                      className="h-9 rounded-lg border-zinc-800 bg-zinc-950 text-zinc-100 hover:bg-zinc-900"
                      onClick={startCreateGateway}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      Add Gateway
                    </Button>
                  </div>
                ) : (
                  filteredGateways.map((gateway) => {
                    const selected = !isCreateMode && gateway.id === selectedGatewayId;
                    const statusReady = readiness?.gatewayId === gateway.id ? readiness.overallOk : false;

                    return (
                      <button
                        key={gateway.id}
                        type="button"
                        onClick={() => selectGateway(gateway.id)}
                        className={cn(
                          "group w-full rounded-lg border p-3.5 text-left transition",
                          selected
                            ? "border-blue-500 bg-blue-500/10"
                            : "border-zinc-800 bg-zinc-950/70 hover:border-zinc-700 hover:bg-zinc-900/70",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 gap-3">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400">
                              <HardDrive className="size-4" aria-hidden="true" />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-zinc-100">{gateway.label}</div>
                              <div className="mt-1 truncate text-xs text-zinc-400">
                                {buildConnectionLabel(gateway)}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                requestDeleteGateway(gateway.id);
                              }}
                              className="rounded-md p-1.5 text-zinc-500 opacity-0 transition hover:bg-white/5 hover:text-red-300 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500/60 group-hover:opacity-100"
                              aria-label={`Delete ${gateway.label}`}
                              title={`Delete ${gateway.label}`}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </button>
                            <div className={cn("size-2.5 rounded-full", selected ? "bg-blue-400" : "bg-zinc-600")} />
                          </div>
                        </div>
                        <div className="mt-3">
                          {statusReady ? <StatusPill tone="good">Ready</StatusPill> : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              <Button
                variant="outline"
                className="mt-auto hidden h-10 rounded-lg border-zinc-800 bg-zinc-950 text-zinc-100 hover:bg-zinc-900 xl:flex"
                onClick={startCreateGateway}
                disabled={isSaving || deletingGatewayId !== null}
              >
                <Plus className="size-4" aria-hidden="true" />
                Add Gateway
              </Button>
            </div>
          </aside>

          <main className="min-w-0 py-5 xl:px-5">
            {activeGateway ? (
              <div className="space-y-5">
                <div className="flex flex-col gap-4 border-b border-zinc-800 pb-5 2xl:flex-row 2xl:items-center 2xl:justify-between">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400">
                      <HardDrive className="size-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        <h2 className="truncate text-2xl font-semibold text-zinc-100">
                          {activeGateway.label}
                        </h2>
                        <StatusPill tone={gatewayStatusTone}>{gatewayStatusLabel}</StatusPill>
                      </div>
                      <div className="mt-1 truncate text-sm text-zinc-500 tabular-nums">
                        {selectedConnectionLabel}
                      </div>
                    </div>
                  </div>

                  {!isCreateMode ? (
                    <div className="flex items-center gap-2 text-xs text-zinc-500 tabular-nums">
                      <span>
                        Last updated: {lastUpdatedLabel ? formatTimestamp(lastUpdatedLabel) : "not yet checked"}
                      </span>
                      <button
                        type="button"
                        onClick={() => void runReadinessCheck()}
                        className="rounded-md p-2 text-blue-400 transition hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                        aria-label="Refresh readiness"
                        title="Refresh readiness"
                      >
                        <RefreshCw className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </div>

                {!isCreateMode && (
                  <Panel className="p-4">
                    <h3 className="text-lg font-semibold text-zinc-100">Connection Overview</h3>
                    <div className="mt-3">
                      <FieldRow
                        icon={Server}
                        label="Host"
                        value={activeGateway.host || "not set"}
                        onCopy={() => activeGateway.host && void copyText(activeGateway.host, "Host")}
                      />
                      <FieldRow
                        icon={User}
                        label="User"
                        value={activeGateway.user || "not set"}
                        onCopy={() => activeGateway.user && void copyText(activeGateway.user, "User")}
                      />
                      <FieldRow
                        icon={Terminal}
                        label="Port"
                        value={String(activeGateway.port || DEFAULT_PORT)}
                        onCopy={() => void copyText(String(activeGateway.port || DEFAULT_PORT), "Port")}
                      />
                      <FieldRow
                        icon={ShieldCheck}
                        label="Service Name"
                        value={activeGateway.serviceName}
                        onCopy={() => void copyText(activeGateway.serviceName, "Service name")}
                      />
                      <FieldRow
                        icon={RefreshCw}
                        label="SSH Alias"
                        value={activeGateway.sshHostAlias || "unused"}
                        onCopy={() =>
                          activeGateway.sshHostAlias && void copyText(activeGateway.sshHostAlias, "SSH alias")}
                      />
                      <FieldRow
                        icon={FolderOpen}
                        label="Repo Path"
                        value={activeGateway.repoPath}
                        onCopy={() => void copyText(activeGateway.repoPath, "Repo path")}
                      />
                    </div>
                  </Panel>
                )}

                {!isCreateMode && (
                  <Panel className="p-4">
                    <h3 className="text-lg font-semibold text-zinc-100">Quick Actions</h3>
                    <p className="mt-1 text-pretty text-sm text-zinc-500">
                      Execute common remote commands and operations.
                    </p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
                      <QuickActionButton
                        icon={Terminal}
                        title="Status"
                        subtitle="Check gateway status"
                        disabled={runningCommand !== null || editorDirty}
                        onClick={() => void runCommand("status")}
                      />
                      <QuickActionButton
                        icon={Play}
                        title="Start"
                        subtitle="Start gateway service"
                        disabled={runningCommand !== null || editorDirty}
                        onClick={() => void runCommand("start")}
                      />
                      <QuickActionButton
                        icon={Square}
                        title="Stop"
                        subtitle="Stop gateway service"
                        disabled={runningCommand !== null || editorDirty}
                        onClick={() => void runCommand("stop")}
                      />
                      <QuickActionButton
                        icon={RotateCcw}
                        title="Restart"
                        subtitle="Restart gateway service"
                        disabled={runningCommand !== null || editorDirty}
                        onClick={() => void runCommand("restart")}
                      />
                      <QuickActionButton
                        icon={FolderOpen}
                        title="Logs"
                        subtitle="View service logs"
                        disabled={runningCommand !== null || editorDirty}
                        onClick={() => void runCommand("logs")}
                      />
                    </div>
                  </Panel>
                )}

                <Panel className="p-4">
                  <h3 className="text-lg font-semibold text-zinc-100">Gateway Details</h3>
                  {isCreateMode ? (
                    <p className="mt-1 text-pretty text-sm text-zinc-500">
                      Save this gateway once the connection details are complete.
                    </p>
                  ) : null}
                  <div className="mt-4">
                    <GatewayFieldGroup gateway={activeGateway} onChange={patchGatewayField} />
                  </div>
                </Panel>
              </div>
            ) : (
              <Panel className="flex min-h-[420px] items-center justify-center border-dashed p-8">
                <div className="max-w-md text-center">
                  <HardDrive className="mx-auto size-9 text-blue-400" aria-hidden="true" />
                  <h2 className="mt-4 text-balance text-xl font-semibold text-zinc-100">Select a gateway</h2>
                  <p className="mt-2.5 text-pretty text-sm text-zinc-500">
                    Choose a gateway from the left rail or add a new one to start managing it here.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-5 h-10 rounded-lg border-zinc-800 bg-zinc-950 text-zinc-100 hover:bg-zinc-900"
                    onClick={startCreateGateway}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Add Gateway
                  </Button>
                </div>
              </Panel>
            )}
          </main>

          {activeGateway ? (
            <aside className="space-y-4 border-t border-zinc-800 py-5 xl:col-start-3 xl:border-l xl:border-t-0 xl:pl-5">
              <Panel className="p-4">
                <h3 className="text-lg font-semibold text-zinc-100">SSH Command Preview</h3>
                <p className="mt-1 text-pretty text-sm text-zinc-500">Use this to connect via SSH.</p>
                <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/70 px-3.5 py-3.5 font-mono text-xs leading-6 text-zinc-100">
                  {sshPreview}
                </pre>
                <div className="mt-4 flex justify-end">
                  <Button
                    variant="outline"
                    className="h-9 rounded-lg border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 hover:bg-zinc-900"
                    onClick={() => void copyText(sshPreview, "SSH command")}
                  >
                    <Copy className="size-4" aria-hidden="true" />
                    Copy Command
                  </Button>
                </div>
              </Panel>

              <Panel className="p-4">
                <h3 className="text-lg font-semibold text-zinc-100">One-Time Linux Setup</h3>
                <p className="mt-1 text-pretty text-sm text-zinc-500">
                  Run this once on each new gateway box so the desktop app can manage the service cleanly.
                </p>
                <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/70 px-3.5 py-3.5 font-mono text-xs leading-6 text-zinc-100">
                  {bootstrapCommand}
                </pre>
                <p className="mt-3 text-pretty text-xs leading-5 text-zinc-500">
                  If the script says permission denied, run it with{" "}
                  <span className="font-mono text-zinc-300">bash</span> or make it executable first with{" "}
                  <span className="font-mono text-zinc-300">chmod +x ./scripts/linux-gateway/bootstrap-admin.sh</span>.
                </p>
              </Panel>

              {!isCreateMode && (
                <Panel className="overflow-hidden">
                  <div className="flex items-center justify-between gap-3 border-b border-zinc-800 p-4">
                    <div>
                      <h3 className="text-lg font-semibold text-zinc-100">Readiness Checks</h3>
                      <p className="mt-1 text-pretty text-sm text-zinc-500">
                        Verify SSH, key auth, repo path, service control, and logs.
                      </p>
                    </div>
                    {readiness ? (
                      <StatusPill tone={readiness.overallOk ? "good" : "warning"}>
                        {readiness.overallOk ? "All checks passed" : "Needs setup"}
                      </StatusPill>
                    ) : null}
                  </div>

                  {readiness ? (
                    <div className="divide-y divide-zinc-800">
                      {readiness.checks.map((check) => (
                        <div key={check.key} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              {check.ok ? (
                                <CheckCircle2 className="size-4 shrink-0 text-emerald-300" aria-hidden="true" />
                              ) : (
                                <AlertCircle className="size-4 shrink-0 text-amber-300" aria-hidden="true" />
                              )}
                              <div className="truncate text-sm font-medium text-zinc-100">{check.label}</div>
                            </div>
                            <div className="mt-1 truncate pl-6 text-xs text-zinc-500">{check.detail}</div>
                          </div>
                          <div className={cn("text-xs font-medium", check.ok ? "text-emerald-300" : "text-amber-300")}>
                            {check.ok ? "OK" : "Check"}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-4 p-4 text-sm text-zinc-500">
                      <p>Run a readiness check to verify the gateway admin path.</p>
                      <Button
                        variant="outline"
                        className="h-9 rounded-lg border-zinc-800 bg-zinc-950 text-zinc-100 hover:bg-zinc-900"
                        onClick={() => void runReadinessCheck()}
                        disabled={!persistedSelectedGateway || checkingReadiness || isSaving}
                      >
                        <ShieldCheck className="size-4" aria-hidden="true" />
                        {checkingReadiness ? "Checking..." : "Check Readiness"}
                      </Button>
                    </div>
                  )}
                </Panel>
              )}

              {!isCreateMode && (
                <Panel className="p-4">
                  <h3 className="text-lg font-semibold text-zinc-100">Command Output</h3>
                  {lastResult ? (
                    <div className="mt-4 space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3.5 py-3">
                          <div className="text-xs text-zinc-500">Gateway</div>
                          <div className="mt-1 truncate font-mono text-xs text-zinc-100">
                            {lastResult.connectionLabel}
                          </div>
                        </div>
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3.5 py-3">
                          <div className="text-xs text-zinc-500">Result</div>
                          <div className={cn("mt-1 text-sm", lastResult.ok ? "text-emerald-300" : "text-red-300")}>
                            {lastResult.ok
                              ? "Success"
                              : `Failed${lastResult.exitCode !== null ? ` (${lastResult.exitCode})` : ""}`}
                          </div>
                        </div>
                      </div>
                      <pre className="max-h-[18rem] overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/70 px-3.5 py-3.5 font-mono text-xs leading-6 text-zinc-100">
                        {lastResult.combinedOutput || "Command returned no output."}
                      </pre>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-lg border border-dashed border-zinc-800 bg-zinc-950/80 px-4 py-5 text-sm text-zinc-500">
                      Run a command to see its output here.
                    </div>
                  )}
                </Panel>
              )}
            </aside>
          ) : null}
        </div>
      </div>

      <ConfirmationDialog
        open={pendingDeleteGatewayId !== null}
        title="Delete gateway?"
        description="This removes the gateway from the local desktop config. You can add it again later if needed."
        confirmLabel="Delete Gateway"
        pending={deletingGatewayId !== null}
        onOpenChange={(open) => {
          if (!open && deletingGatewayId === null) {
            setPendingDeleteGatewayId(null);
          }
        }}
        onConfirm={() => void confirmDeleteGateway()}
      />
    </div>
  );
}
