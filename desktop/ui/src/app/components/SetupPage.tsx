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

function updateGateway(
  config: GatewayAdminConfig,
  gatewayId: string,
  apply: (gateway: GatewayAdminGateway) => GatewayAdminGateway,
) {
  return {
    gateways: config.gateways.map((gateway) =>
      gateway.id === gatewayId ? apply(gateway) : gateway
    ),
  };
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

export function SetupPage() {
  const [config, setConfig] = useState<GatewayAdminConfig | null>(null);
  const [selectedGatewayId, setSelectedGatewayId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [customCommand] = useState("");
  const [lastResult, setLastResult] = useState<GatewayAdminCommandResult | null>(null);
  const [readiness, setReadiness] = useState<GatewayAdminReadinessResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [runningCommand, setRunningCommand] = useState<GatewayAdminCommand | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);

  useEffect(() => {
    let mounted = true;

    void window.gymMotionDesktop
      .getGatewayAdminConfig()
      .then((nextConfig) => {
        if (!mounted) {
          return;
        }

        setConfig(nextConfig);
        setSelectedGatewayId((current) => current ?? nextConfig.gateways[0]?.id ?? null);
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "Failed to load gateway config.");
      });

    return () => {
      mounted = false;
    };
  }, []);

  const selectedGateway = useMemo(
    () => config?.gateways.find((gateway) => gateway.id === selectedGatewayId) ?? null,
    [config, selectedGatewayId],
  );

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

  const canSave =
    !!config &&
    config.gateways.every((gateway) =>
      gateway.label.trim() &&
      ((gateway.host?.trim() && gateway.user?.trim()) || gateway.sshHostAlias?.trim()),
    );

  useEffect(() => {
    setReadiness(null);
  }, [selectedGatewayId, config]);

  async function saveConfig(nextConfig: GatewayAdminConfig) {
    setIsSaving(true);

    try {
      const saved = await window.gymMotionDesktop.saveGatewayAdminConfig(nextConfig);
      setConfig(saved);
      setSelectedGatewayId((current) =>
        current && saved.gateways.some((gateway) => gateway.id === current)
          ? current
          : saved.gateways[0]?.id ?? null,
      );
      toast.success("Gateway config saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save gateway config.");
    } finally {
      setIsSaving(false);
    }
  }

  function patchSelectedGateway<TKey extends keyof GatewayAdminGateway>(
    field: TKey,
    value: GatewayAdminGateway[TKey],
  ) {
    if (!config || !selectedGateway) {
      return;
    }

    setConfig(
      updateGateway(config, selectedGateway.id, (gateway) => ({
        ...gateway,
        [field]: value,
      })),
    );
  }

  function addGateway() {
    setConfig((current) => {
      const nextConfig = current ?? { gateways: [] };
      const nextGateway = createGatewayDraft();
      setSelectedGatewayId(nextGateway.id);
      return {
        gateways: [...nextConfig.gateways, nextGateway],
      };
    });
  }

  function removeSelectedGateway() {
    if (!config || !selectedGateway) {
      return;
    }

    const nextGateways = config.gateways.filter((gateway) => gateway.id !== selectedGateway.id);
    setConfig({ gateways: nextGateways });
    setSelectedGatewayId(nextGateways[0]?.id ?? null);
    if (lastResult?.gatewayId === selectedGateway.id) {
      setLastResult(null);
    }
  }

  async function runCommand(command: GatewayAdminCommand) {
    if (!selectedGateway) {
      toast.error("Select a gateway first.");
      return;
    }

    setRunningCommand(command);

    try {
      const result = await window.gymMotionDesktop.runGatewayAdminCommand({
        gatewayId: selectedGateway.id,
        command,
        customCommand,
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
    if (!selectedGateway) {
      toast.error("Select a gateway first.");
      return;
    }

    setCheckingReadiness(true);

    try {
      const nextReadiness = await window.gymMotionDesktop.checkGatewayAdminReadiness(
        selectedGateway.id,
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

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}.`);
    }
  }

  const bootstrapCommand = buildBootstrapCommand(selectedGateway);
  const sshPreview = buildSshPreview(selectedGateway);
  const selectedConnectionLabel = selectedGateway ? buildConnectionLabel(selectedGateway) : "No gateway selected";
  const lastUpdatedLabel = readiness?.checkedAt ?? lastResult?.finishedAt ?? null;
  const gatewayStatusTone = readiness?.overallOk ? "bg-[#16361f] text-[#7ee2a0]" : "bg-[#1c2430] text-zinc-300";
  const gatewayStatusLabel = readiness
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

            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                className="h-10 rounded-xl border-[#2a313b] bg-transparent px-4 text-sm text-zinc-100 hover:bg-[#151b24]"
                onClick={addGateway}
              >
                <Plus className="size-4" />
                Add Gateway
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-xl border-[#2a313b] bg-transparent px-4 text-sm text-zinc-100 hover:bg-[#151b24]"
                onClick={() => void runReadinessCheck()}
                disabled={!selectedGateway || checkingReadiness}
              >
                <ShieldCheck className="size-4" />
                {checkingReadiness ? "Checking…" : "Check Readiness"}
              </Button>
              <Button
                className="h-10 rounded-xl bg-[#2f80ff] px-4 text-sm text-white hover:bg-[#256fe2]"
                onClick={() => config && void saveConfig(config)}
                disabled={!config || !canSave || isSaving}
              >
                <CheckCircle2 className="size-4" />
                Save Config
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
                {filteredGateways.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[#27303a] bg-[#121820] px-4 py-5 text-sm text-zinc-500">
                    No gateways yet. Add one to start the admin flow.
                  </div>
                ) : (
                  filteredGateways.map((gateway) => {
                    const selected = gateway.id === selectedGatewayId;
                    const statusReady = readiness?.gatewayId === gateway.id ? readiness.overallOk : false;

                    return (
                      <button
                        key={gateway.id}
                        type="button"
                        onClick={() => setSelectedGatewayId(gateway.id)}
                        className={[
                          "w-full rounded-2xl border px-3.5 py-3.5 text-left transition",
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
                          <div className={selected ? "mt-1 size-3 rounded-full bg-[#2f80ff]" : "mt-1 size-3 rounded-full bg-transparent"} />
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
            {selectedGateway ? (
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
                            {selectedGateway.label}
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
                  </div>
                </div>

                <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.05fr)_minmax(300px,0.85fr)]">
                  <div className="space-y-6">
                    <section className="border-b border-[#20262f] pb-6">
                      <div className="mb-3">
                        <h3 className="text-[1.25rem] font-medium text-zinc-100">Connection Overview</h3>
                      </div>
                      <div>
                        <FieldRow
                          icon={Server}
                          label="Host"
                          value={selectedGateway.host || "not set"}
                          onCopy={() => selectedGateway.host && void copyText(selectedGateway.host, "Host")}
                        />
                        <FieldRow
                          icon={User}
                          label="User"
                          value={selectedGateway.user || "not set"}
                          onCopy={() => selectedGateway.user && void copyText(selectedGateway.user, "User")}
                        />
                        <FieldRow
                          icon={Terminal}
                          label="Port"
                          value={String(selectedGateway.port || DEFAULT_PORT)}
                          onCopy={() => void copyText(String(selectedGateway.port || DEFAULT_PORT), "Port")}
                        />
                        <FieldRow
                          icon={ShieldCheck}
                          label="Service Name"
                          value={selectedGateway.serviceName}
                          onCopy={() => void copyText(selectedGateway.serviceName, "Service name")}
                        />
                        <FieldRow
                          icon={RefreshCw}
                          label="SSH Alias"
                          value={selectedGateway.sshHostAlias || "unused"}
                          onCopy={() =>
                            selectedGateway.sshHostAlias && void copyText(selectedGateway.sshHostAlias, "SSH alias")}
                        />
                        <FieldRow
                          icon={FolderOpen}
                          label="Repo Path"
                          value={selectedGateway.repoPath}
                          onCopy={() => void copyText(selectedGateway.repoPath, "Repo path")}
                        />
                      </div>
                    </section>

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
                          disabled={runningCommand !== null}
                          onClick={() => void runCommand("status")}
                        />
                        <QuickActionButton
                          icon={Play}
                          title="Start"
                          subtitle="Start gateway service"
                          disabled={runningCommand !== null}
                          onClick={() => void runCommand("start")}
                        />
                        <QuickActionButton
                          icon={Square}
                          title="Stop"
                          subtitle="Stop gateway service"
                          disabled={runningCommand !== null}
                          onClick={() => void runCommand("stop")}
                        />
                        <QuickActionButton
                          icon={RotateCcw}
                          title="Restart"
                          subtitle="Restart gateway service"
                          disabled={runningCommand !== null}
                          onClick={() => void runCommand("restart")}
                        />
                        <QuickActionButton
                          icon={FolderOpen}
                          title="Logs"
                          subtitle="View service logs"
                          disabled={runningCommand !== null}
                          onClick={() => void runCommand("logs")}
                        />
                      </div>
                    </section>

                    <section className="space-y-4">
                      <div>
                        <h3 className="text-[1.15rem] font-medium text-zinc-100">Gateway Details</h3>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="space-y-2 text-sm">
                          <span className="text-zinc-400">Label</span>
                          <input
                            value={selectedGateway.label}
                            onChange={(event) => patchSelectedGateway("label", event.target.value)}
                            className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
                            placeholder="Zone A Gateway"
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span className="text-zinc-400">Host</span>
                          <input
                            value={selectedGateway.host ?? ""}
                            onChange={(event) => patchSelectedGateway("host", event.target.value || null)}
                            className="h-10 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-3.5 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
                            placeholder="192.168.1.174"
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span className="text-zinc-400">User</span>
                          <input
                            value={selectedGateway.user ?? ""}
                            onChange={(event) => patchSelectedGateway("user", event.target.value || null)}
                            className="h-12 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-4 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
                            placeholder="adam-blumoff"
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span className="text-zinc-400">Port</span>
                          <input
                            value={String(selectedGateway.port)}
                            onChange={(event) => {
                              const nextPort = Number(event.target.value);
                              if (!Number.isFinite(nextPort)) {
                                return;
                              }
                              patchSelectedGateway("port", nextPort);
                            }}
                            className="h-12 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-4 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
                            placeholder={String(DEFAULT_PORT)}
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span className="text-zinc-400">Service Name</span>
                          <input
                            value={selectedGateway.serviceName}
                            onChange={(event) => patchSelectedGateway("serviceName", event.target.value)}
                            className="h-12 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-4 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
                            placeholder={DEFAULT_SERVICE_NAME}
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span className="text-zinc-400">SSH Alias Fallback</span>
                          <input
                            value={selectedGateway.sshHostAlias ?? ""}
                            onChange={(event) => patchSelectedGateway("sshHostAlias", event.target.value || null)}
                            className="h-12 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-4 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
                            placeholder="Optional"
                          />
                        </label>
                        <label className="space-y-2 text-sm md:col-span-2">
                          <span className="text-zinc-400">Repo Path</span>
                          <input
                            value={selectedGateway.repoPath}
                            onChange={(event) => patchSelectedGateway("repoPath", event.target.value)}
                            className="h-12 w-full rounded-xl border border-[#2a313b] bg-[#121820] px-4 font-mono text-sm text-zinc-100 outline-none transition focus:border-[#2f80ff]"
                            placeholder={DEFAULT_REPO_PATH}
                          />
                        </label>
                      </div>
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

                    <section className="space-y-4">
                      <div>
                        <h3 className="text-[1.15rem] font-medium text-zinc-100">Notes</h3>
                      </div>
                      <textarea
                        value={selectedGateway.notes ?? ""}
                        onChange={(event) => patchSelectedGateway("notes", event.target.value || null)}
                        maxLength={200}
                        className="min-h-32 w-full rounded-2xl border border-[#2a313b] bg-[#121820] px-3.5 py-3.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#2f80ff]"
                        placeholder="Optional notes about this gateway..."
                      />
                      <div className="text-right text-sm text-zinc-500">
                        {(selectedGateway.notes ?? "").length} / 200
                      </div>
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

                    <div className="pt-2">
                      <Button
                        variant="destructive"
                        className="h-10 rounded-xl px-4 text-sm"
                        onClick={removeSelectedGateway}
                        disabled={isSaving}
                      >
                        <Trash2 className="size-4" />
                        Remove Gateway
                      </Button>
                    </div>
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
    </div>
  );
}
