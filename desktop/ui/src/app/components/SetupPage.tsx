import { useEffect, useMemo, useState } from "react";
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
import { Card, CardContent } from "./ui/card";

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
  icon: typeof Server;
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-[#20262f] py-3.5 last:border-b-0">
      <div className="flex size-8 items-center justify-center rounded-lg border border-[#253449] bg-[#0f151d] text-[#2f80ff]">
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-zinc-400">{label}</div>
      </div>
      <div className="min-w-0 max-w-[50%] truncate text-right text-[13px] text-[#59a3ff]">
        {value}
      </div>
      {onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md p-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          title={`Copy ${label}`}
        >
          <Copy className="size-4" />
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
  icon: typeof Terminal;
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
      className="group flex min-h-20 flex-col justify-between rounded-none border-r border-[#20262f] px-2 py-2 text-left transition last:border-r-0 disabled:opacity-40 disabled:hover:bg-transparent xl:px-3"
    >
      <div className="flex items-center gap-2.5 text-zinc-100">
        <Icon className="size-4 text-[#2f80ff]" />
        <span className="text-base font-medium">{title}</span>
      </div>
      <div className="pl-7 text-xs text-zinc-500 group-hover:text-zinc-400">{subtitle}</div>
    </button>
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
          className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
          placeholder="Zone A Gateway"
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">Host</span>
        <input
          value={gateway.host ?? ""}
          onChange={(event) => onChange("host", event.target.value || null)}
          className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
          placeholder="192.168.1.174"
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">User</span>
        <input
          value={gateway.user ?? ""}
          onChange={(event) => onChange("user", event.target.value || null)}
          className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
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
          className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
          placeholder={String(DEFAULT_PORT)}
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">Service Name</span>
        <input
          value={gateway.serviceName}
          onChange={(event) => onChange("serviceName", event.target.value)}
          className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
          placeholder={DEFAULT_SERVICE_NAME}
        />
      </label>
      <label className="space-y-2 text-sm">
        <span className="text-zinc-400">SSH Alias Fallback</span>
        <input
          value={gateway.sshHostAlias ?? ""}
          onChange={(event) => onChange("sshHostAlias", event.target.value || null)}
          className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
          placeholder="Optional"
        />
      </label>
      <label className="space-y-2 text-sm md:col-span-2">
        <span className="text-zinc-400">Repo Path</span>
        <input
          value={gateway.repoPath}
          onChange={(event) => onChange("repoPath", event.target.value)}
          className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
          placeholder={DEFAULT_REPO_PATH}
        />
      </label>
      <label className="space-y-2 text-sm md:col-span-2">
        <span className="text-zinc-400">Notes</span>
        <textarea
          value={gateway.notes ?? ""}
          onChange={(event) => onChange("notes", event.target.value || null)}
          maxLength={200}
          className="min-h-28 w-full rounded-2xl border border-[#2a313b] bg-[#121820] px-3.5 py-3.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#2f80ff]"
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
  const saveStatusTone = isCreateMode || editorDirty ? "text-[#f5c04b]" : "text-zinc-500";
  const selectedConnectionLabel = activeGateway ? buildConnectionLabel(activeGateway) : "No gateway selected";
  const lastUpdatedLabel = readiness?.checkedAt ?? lastResult?.finishedAt ?? null;
  const gatewayStatusTone = readiness?.overallOk ? "bg-[#16361f] text-[#7ee2a0]" : "bg-[#1c2430] text-zinc-300";
  const gatewayStatusLabel = isCreateMode
    ? "Draft"
    : readiness
      ? readiness.overallOk
        ? "Active"
        : "Needs setup"
      : "Unverified";

  return (
    <div className="flex-1 overflow-auto bg-black p-0">
      <div className="mx-auto max-w-[1420px] px-6 pb-6 pt-6">
        <div className="border-b border-[#20262f] pb-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-2.5">
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-600">Operations</div>
              <h1 className="text-[2rem] font-semibold tracking-tight text-zinc-50">Gateway Admin</h1>
              <p className="max-w-xl text-[15px] text-zinc-400">
                Manage
                <span className="mx-1 text-[#59a3ff]">Linux gateways</span>
                over
                <span className="mx-1 text-[#59a3ff]">SSH</span>
                from this desktop app.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {saveStatusLabel ? (
                <div className={`mr-1 text-sm ${saveStatusTone}`}>{saveStatusLabel}</div>
              ) : null}
              <Button
                variant="outline"
                className="h-10 rounded-xl border-[#2a313b] bg-transparent px-4 text-sm text-zinc-100 hover:bg-[#151b24]"
                onClick={startCreateGateway}
                disabled={isSaving || deletingGatewayId !== null}
              >
                <Plus className="size-4" />
                Add Gateway
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-xl border-[#2a313b] bg-transparent px-4 text-sm text-zinc-100 hover:bg-[#151b24]"
                onClick={() => void runReadinessCheck()}
                disabled={!persistedSelectedGateway || checkingReadiness || isSaving}
              >
                <ShieldCheck className="size-4" />
                {checkingReadiness ? "Checking..." : "Check Readiness"}
              </Button>
              {(isCreateMode || editorDirty) && (
                <Button
                  variant="outline"
                  className="h-10 rounded-xl border-[#2a313b] bg-transparent px-4 text-sm text-zinc-100 hover:bg-[#151b24]"
                  onClick={cancelEditing}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              )}
              <Button
                className="h-10 rounded-xl bg-[#2f80ff] px-4 text-sm text-white hover:bg-[#256fe2]"
                onClick={() => void saveGateway()}
                disabled={!canSaveGateway || isSaving}
              >
                <CheckCircle2 className="size-4" />
                {isSaving ? "Saving..." : "Save Gateway"}
              </Button>
            </div>
          </div>
        </div>

        <div className="grid min-h-[720px] grid-cols-1 gap-6 pt-5 xl:grid-cols-[260px_minmax(0,1fr)]">
          <section className="border-r border-[#20262f] pr-5">
            <div className="space-y-4">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
                Gateways
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search gateways..."
                  className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] pl-11 pr-4 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#2f80ff]"
                />
              </div>

              <div className="space-y-3">
                {isCreateMode && activeGateway ? (
                  <div className="w-full rounded-2xl border border-[#2f80ff] bg-[#131d2a] px-3.5 py-3.5 shadow-[0_0_0_1px_rgba(47,128,255,0.15)]">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex size-9 items-center justify-center rounded-xl border border-[#274366] bg-[#102038] text-[#2f80ff]">
                        <HardDrive className="size-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-medium text-zinc-100">
                          {activeGateway.label || "New Gateway"}
                        </div>
                        <div className="mt-1 truncate text-[13px] text-[#59a3ff]">
                          {buildConnectionLabel(activeGateway)}
                        </div>
                        <div className="mt-2.5 inline-flex rounded-full bg-[#3b2a0f] px-2.5 py-1 text-[11px] font-medium text-[#f5c04b]">
                          Draft
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {filteredGateways.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[#27303a] bg-[#121820] px-4 py-5 text-sm text-zinc-500">
                    No gateways yet. Add one to start the admin flow.
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
                        className={[
                          "group w-full rounded-2xl border px-3.5 py-3.5 text-left transition",
                          selected
                            ? "border-[#2f80ff] bg-[#131d2a] shadow-[0_0_0_1px_rgba(47,128,255,0.15)]"
                            : "border-[#28303a] bg-[#111720] hover:border-[#33404d] hover:bg-[#131a23]",
                        ].join(" ")}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 gap-3">
                            <div className="mt-0.5 flex size-9 items-center justify-center rounded-xl border border-[#274366] bg-[#102038] text-[#2f80ff]">
                              <HardDrive className="size-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-[15px] font-medium text-zinc-100">{gateway.label}</div>
                              <div className="mt-1 truncate text-[13px] text-[#59a3ff]">
                                {buildConnectionLabel(gateway)}
                              </div>
                            </div>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                requestDeleteGateway(gateway.id);
                              }}
                              className="rounded-md p-1.5 text-zinc-500 opacity-0 transition hover:bg-white/5 hover:text-[#ff7f7f] group-hover:opacity-100 focus:opacity-100"
                              title={`Delete ${gateway.label}`}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                            <div
                              className={
                                selected
                                  ? "size-3 rounded-full bg-[#2f80ff]"
                                  : "size-3 rounded-full bg-transparent"
                              }
                            />
                          </div>
                        </div>
                        {statusReady ? (
                          <div className="mt-2.5 inline-flex rounded-full bg-[#16361f] px-2.5 py-1 text-[11px] font-medium text-[#7ee2a0]">
                            Ready
                          </div>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </section>

          <section className="min-w-0">
            {activeGateway ? (
              <div className="space-y-6">
                <div className="border-b border-[#20262f] pb-5">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="flex size-10 items-center justify-center rounded-xl border border-[#274366] bg-[#102038] text-[#2f80ff]">
                        <HardDrive className="size-4.5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-3">
                          <h2 className="truncate text-[1.65rem] font-semibold text-zinc-100">
                            {activeGateway.label}
                          </h2>
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${gatewayStatusTone}`}>
                            {gatewayStatusLabel}
                          </span>
                        </div>
                        <div className="mt-1.5 truncate text-[13px] text-zinc-500">
                          {selectedConnectionLabel}
                        </div>
                      </div>
                    </div>

                    {!isCreateMode ? (
                      <div className="flex items-center gap-2.5 text-[13px] text-zinc-500">
                        <span>Last updated: {lastUpdatedLabel ? formatTimestamp(lastUpdatedLabel) : "not yet checked"}</span>
                        <button
                          type="button"
                          onClick={() => void runReadinessCheck()}
                          className="rounded-md p-2 text-[#2f80ff] transition hover:bg-white/5"
                          title="Refresh readiness"
                        >
                          <RefreshCw className="size-4" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.05fr)_minmax(300px,0.85fr)]">
                  <div className="space-y-6">
                    {!isCreateMode && (
                      <section className="border-b border-[#20262f] pb-6">
                        <div className="mb-3">
                          <h3 className="text-[1.25rem] font-medium text-zinc-100">Connection Overview</h3>
                        </div>
                        <div>
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
                      </section>
                    )}

                    {!isCreateMode && (
                      <section className="border-b border-[#20262f] pb-6">
                        <div className="mb-4">
                          <h3 className="text-[1.25rem] font-medium text-zinc-100">Quick Actions</h3>
                          <p className="mt-1.5 text-[13px] text-zinc-500">
                            Execute common remote commands and operations.
                          </p>
                        </div>
                        <div className="grid gap-0 rounded-2xl border border-[#20262f] bg-[#0f141b] md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
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
                      </section>
                    )}

                    <section className="space-y-4">
                      <div>
                        <h3 className="text-[1.15rem] font-medium text-zinc-100">Gateway Details</h3>
                        {isCreateMode ? (
                          <p className="mt-1.5 text-[13px] text-zinc-500">
                            Save this gateway once the connection details are complete.
                          </p>
                        ) : null}
                      </div>
                      <GatewayFieldGroup gateway={activeGateway} onChange={patchGatewayField} />
                    </section>
                  </div>

                  <div className="space-y-6">
                    <section className="space-y-4">
                      <div>
                        <h3 className="text-[1.25rem] font-medium text-zinc-100">SSH Command Preview</h3>
                        <p className="mt-1.5 text-[13px] text-zinc-500">Use this to connect via SSH.</p>
                      </div>
                      <Card className="border-[#20262f] bg-[#10161e]">
                        <CardContent className="pt-6">
                          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-[#28303a] bg-[#151b24] px-3.5 py-3.5 font-mono text-[12px] leading-6 text-zinc-100">
                            {sshPreview}
                          </pre>
                          <div className="mt-5 flex justify-end">
                            <Button
                              variant="outline"
                              className="h-10 rounded-xl border-[#2a313b] bg-transparent px-4 text-sm text-zinc-100 hover:bg-[#151b24]"
                              onClick={() => void copyText(sshPreview, "SSH command")}
                            >
                              <Copy className="size-4" />
                              Copy Command
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </section>

                    <section className="space-y-4 border-t border-[#20262f] pt-6">
                      <div>
                        <h3 className="text-[1.15rem] font-medium text-zinc-100">One-Time Linux Setup</h3>
                        <p className="mt-1.5 text-[13px] text-zinc-500">
                          Run this once on each new gateway box so the desktop app can manage the service cleanly.
                        </p>
                      </div>
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-[#28303a] bg-[#151b24] px-3.5 py-3.5 font-mono text-[12px] leading-6 text-zinc-100">
                        {bootstrapCommand}
                      </pre>
                      <div className="text-[13px] text-zinc-500">
                        If the script says permission denied, run it with
                        <span className="mx-1 font-mono text-zinc-300">bash</span>
                        or make it executable first with
                        <span className="mx-1 font-mono text-zinc-300">chmod +x ./scripts/linux-gateway/bootstrap-admin.sh</span>.
                      </div>
                    </section>

                    {!isCreateMode && (
                      <>
                        <section className="space-y-4 border-t border-[#20262f] pt-6">
                          <div>
                            <h3 className="text-[1.15rem] font-medium text-zinc-100">Readiness</h3>
                            <p className="mt-1.5 text-[13px] text-zinc-500">
                              This tells you what still needs to be true before the admin page feels automatic.
                            </p>
                          </div>
                          {readiness ? (
                            <div className="space-y-3">
                              <div className="flex items-center gap-3 rounded-2xl border border-[#28303a] bg-[#111720] px-3.5 py-3.5">
                                {readiness.overallOk ? (
                                  <CheckCircle2 className="size-5 text-[#7ee2a0]" />
                                ) : (
                                  <AlertCircle className="size-5 text-[#f5c04b]" />
                                )}
                                <div className="min-w-0">
                                  <div className="text-[13px] font-medium text-zinc-100">
                                    {readiness.overallOk ? "Gateway admin is ready" : "Gateway admin needs setup"}
                                  </div>
                                  <div className="truncate text-[12px] text-zinc-500">{readiness.connectionLabel}</div>
                                </div>
                              </div>

                              {readiness.checks.map((check) => (
                                <div
                                  key={check.key}
                                  className="rounded-2xl border border-[#28303a] bg-[#111720] px-3.5 py-3.5"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="text-[13px] font-medium text-zinc-100">{check.label}</div>
                                    <div className={`${check.ok ? "text-[#7ee2a0]" : "text-[#f5c04b]"} text-[12px]`}>
                                      {check.ok ? "Ready" : "Needs attention"}
                                    </div>
                                  </div>
                                  <div className="mt-1.5 text-[12px] text-zinc-500">{check.detail}</div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[#28303a] bg-[#111720] px-4 py-5 text-[13px] text-zinc-500">
                              Run a readiness check to verify SSH, key auth, repo path, sudo service control, and logs.
                            </div>
                          )}
                        </section>

                        <section className="space-y-4 border-t border-[#20262f] pt-6">
                          <div>
                            <h3 className="text-[1.15rem] font-medium text-zinc-100">Command Output</h3>
                          </div>
                          {lastResult ? (
                            <div className="space-y-3">
                              <div className="grid gap-3 md:grid-cols-2">
                                <div className="rounded-2xl border border-[#28303a] bg-[#111720] px-3.5 py-3.5">
                                  <div className="text-[12px] text-zinc-500">Gateway</div>
                                  <div className="mt-1 font-mono text-[13px] text-zinc-100">{lastResult.connectionLabel}</div>
                                </div>
                                <div className="rounded-2xl border border-[#28303a] bg-[#111720] px-3.5 py-3.5">
                                  <div className="text-[12px] text-zinc-500">Result</div>
                                  <div className={`mt-1 text-[13px] ${lastResult.ok ? "text-[#7ee2a0]" : "text-[#ff7f7f]"}`}>
                                    {lastResult.ok
                                      ? "Success"
                                      : `Failed${lastResult.exitCode !== null ? ` (${lastResult.exitCode})` : ""}`}
                                  </div>
                                </div>
                              </div>
                              <pre className="max-h-[18rem] overflow-auto whitespace-pre-wrap rounded-2xl border border-[#28303a] bg-[#111720] px-3.5 py-3.5 font-mono text-[12px] leading-6 text-zinc-100">
                                {lastResult.combinedOutput || "Command returned no output."}
                              </pre>
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[#28303a] bg-[#111720] px-4 py-5 text-[13px] text-zinc-500">
                              Run a command to see its output here.
                            </div>
                          )}
                        </section>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-dashed border-[#28303a] bg-[#111720]">
                <div className="max-w-md text-center">
                  <HardDrive className="mx-auto size-9 text-[#2f80ff]" />
                  <h2 className="mt-4 text-xl font-semibold text-zinc-100">Select a gateway</h2>
                  <p className="mt-2.5 text-sm text-zinc-500">
                    Choose a gateway from the left rail or add a new one to start managing it here.
                  </p>
                </div>
              </div>
            )}
          </section>
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
