import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Play, Plus, RotateCcw, ShieldCheck, Square, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type {
  GatewayAdminCommand,
  GatewayAdminCommandResult,
  GatewayAdminConfig,
  GatewayAdminGateway,
  GatewayAdminReadinessResult,
} from "@core/services";

import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

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
    return "Never";
  }

  return new Date(value).toLocaleString();
}

function buildCommandTitle(command: GatewayAdminCommand) {
  switch (command) {
    case "status":
      return "Service Status";
    case "start":
      return "Start Service";
    case "stop":
      return "Stop Service";
    case "restart":
      return "Restart Service";
    case "logs":
      return "Recent Logs";
    case "custom":
      return "Custom Command";
  }
}

export function SetupPage() {
  const [config, setConfig] = useState<GatewayAdminConfig | null>(null);
  const [selectedGatewayId, setSelectedGatewayId] = useState<string | null>(null);
  const [customCommand, setCustomCommand] = useState("");
  const [lastResult, setLastResult] = useState<GatewayAdminCommandResult | null>(null);
  const [readiness, setReadiness] = useState<GatewayAdminReadinessResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [runningCommand, setRunningCommand] = useState<GatewayAdminCommand | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(false);

  useEffect(() => {
    let mounted = true;

    void window.gymMotionDesktop.getGatewayAdminConfig().then((nextConfig) => {
      if (!mounted) {
        return;
      }

      setConfig(nextConfig);
      setSelectedGatewayId((current) => current ?? nextConfig.gateways[0]?.id ?? null);
    }).catch((error) => {
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
      if (result.ok) {
        toast.success(`${buildCommandTitle(command)} finished.`);
      } else {
        toast.error(`${buildCommandTitle(command)} failed.`);
      }
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

  const gatewayList = config?.gateways ?? [];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Gateway Admin</h1>
            <p className="text-sm text-zinc-500">
              Manage Linux gateways over SSH from this desktop app.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={addGateway}>
              <Plus className="size-4" />
              Add Gateway
            </Button>
            <Button
              variant="outline"
              onClick={() => void runReadinessCheck()}
              disabled={!selectedGateway || checkingReadiness}
            >
              <ShieldCheck className="size-4" />
              {checkingReadiness ? "Checking…" : "Check Readiness"}
            </Button>
            <Button
              onClick={() => config && void saveConfig(config)}
              disabled={!config || !canSave || isSaving}
            >
              Save Config
            </Button>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="border-zinc-800 bg-zinc-950/80">
            <CardHeader>
              <CardTitle>Saved Gateways</CardTitle>
              <CardDescription>These gateway entries are stored locally on this desktop.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {gatewayList.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
                  No gateways yet. Add one with a host, user, and port, or keep using an SSH alias if you prefer.
                </div>
              ) : (
                gatewayList.map((gateway) => {
                  const selected = gateway.id === selectedGatewayId;

                  return (
                    <button
                      key={gateway.id}
                      type="button"
                      onClick={() => setSelectedGatewayId(gateway.id)}
                      className={[
                        "w-full rounded-xl border px-4 py-3 text-left transition-colors",
                        selected
                          ? "border-blue-500/50 bg-blue-500/10 text-zinc-100"
                          : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900",
                      ].join(" ")}
                    >
                      <div className="truncate text-sm font-medium">{gateway.label}</div>
                      <div className="mt-1 truncate font-mono text-xs text-zinc-500">
                        {gateway.host && gateway.user
                          ? `${gateway.user}@${gateway.host}:${gateway.port}`
                          : gateway.sshHostAlias || "connection not set"}
                      </div>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card className="border-zinc-800 bg-zinc-950/80">
              <CardHeader>
                <CardTitle>Gateway Details</CardTitle>
                <CardDescription>
                  Prefer direct host, user, and port here. SSH aliases still work as a fallback.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedGateway ? (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="space-y-2 text-sm">
                        <span className="text-zinc-400">Label</span>
                        <input
                          value={selectedGateway.label}
                          onChange={(event) => patchSelectedGateway("label", event.target.value)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                          placeholder="Zone A Gateway"
                        />
                      </label>
                      <label className="space-y-2 text-sm">
                        <span className="text-zinc-400">Host</span>
                        <input
                          value={selectedGateway.host ?? ""}
                          onChange={(event) =>
                            patchSelectedGateway("host", event.target.value || null)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                          placeholder="192.168.1.174"
                        />
                      </label>
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <label className="space-y-2 text-sm">
                        <span className="text-zinc-400">User</span>
                        <input
                          value={selectedGateway.user ?? ""}
                          onChange={(event) =>
                            patchSelectedGateway("user", event.target.value || null)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition focus:border-blue-500"
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
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                          placeholder={String(DEFAULT_PORT)}
                        />
                      </label>
                      <label className="space-y-2 text-sm">
                        <span className="text-zinc-400">Service Name</span>
                        <input
                          value={selectedGateway.serviceName}
                          onChange={(event) =>
                            patchSelectedGateway("serviceName", event.target.value)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                          placeholder={DEFAULT_SERVICE_NAME}
                        />
                      </label>
                    </div>

                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <label className="space-y-2 text-sm">
                        <span className="text-zinc-400">Repo Path</span>
                        <input
                          value={selectedGateway.repoPath}
                          onChange={(event) =>
                            patchSelectedGateway("repoPath", event.target.value)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                          placeholder={DEFAULT_REPO_PATH}
                        />
                      </label>
                      <label className="space-y-2 text-sm">
                        <span className="text-zinc-400">SSH Alias Fallback</span>
                        <input
                          value={selectedGateway.sshHostAlias ?? ""}
                          onChange={(event) =>
                            patchSelectedGateway("sshHostAlias", event.target.value || null)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                          placeholder="Optional"
                        />
                      </label>
                      <div className="flex items-end">
                        <Button
                          variant="destructive"
                          onClick={removeSelectedGateway}
                          disabled={isSaving}
                        >
                          <Trash2 className="size-4" />
                          Remove
                        </Button>
                      </div>
                    </div>

                    <label className="block space-y-2 text-sm">
                      <span className="text-zinc-400">Notes</span>
                      <textarea
                        value={selectedGateway.notes ?? ""}
                        onChange={(event) =>
                          patchSelectedGateway("notes", event.target.value || null)}
                        className="min-h-24 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                        placeholder="Optional notes about this gateway box."
                      />
                    </label>
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-sm text-zinc-500">
                    Select a gateway on the left, or add one to get started.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/80">
              <CardHeader>
                <CardTitle>Readiness</CardTitle>
                <CardDescription>
                  This tells you what still needs to be true before the admin page feels automatic.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {readiness ? (
                  <>
                    <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                      {readiness.overallOk ? (
                        <CheckCircle2 className="size-5 text-emerald-300" />
                      ) : (
                        <AlertCircle className="size-5 text-amber-300" />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-zinc-100">
                          {readiness.overallOk ? "Gateway admin is ready" : "Gateway admin needs setup"}
                        </div>
                        <div className="truncate font-mono text-xs text-zinc-500">
                          {readiness.connectionLabel}
                        </div>
                      </div>
                    </div>
                    <div className="space-y-3">
                      {readiness.checks.map((check) => (
                        <div
                          key={check.key}
                          className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium text-zinc-100">{check.label}</div>
                            <div className={check.ok ? "text-emerald-300" : "text-amber-300"}>
                              {check.ok ? "Ready" : "Needs attention"}
                            </div>
                          </div>
                          <div className="mt-2 text-sm text-zinc-500">{check.detail}</div>
                        </div>
                      ))}
                    </div>
                    {!readiness.overallOk ? (
                      <div className="space-y-2">
                        <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">
                          One-Time Linux Bootstrap
                        </div>
                        <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-black/50 px-3 py-2 font-mono text-xs text-zinc-300">
                          {readiness.bootstrapCommand}
                        </pre>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-sm text-zinc-500">
                    Run a readiness check to verify SSH, key auth, repo path, sudo service control, and logs.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/80">
              <CardHeader>
                <CardTitle>Remote Actions</CardTitle>
                <CardDescription>
                  These commands run through local SSH with first-connect host trust enabled.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void runCommand("status")}
                    disabled={!selectedGateway || runningCommand !== null}
                  >
                    <Terminal className="size-4" />
                    Status
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void runCommand("start")}
                    disabled={!selectedGateway || runningCommand !== null}
                  >
                    <Play className="size-4" />
                    Start
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void runCommand("stop")}
                    disabled={!selectedGateway || runningCommand !== null}
                  >
                    <Square className="size-4" />
                    Stop
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void runCommand("restart")}
                    disabled={!selectedGateway || runningCommand !== null}
                  >
                    <RotateCcw className="size-4" />
                    Restart
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void runCommand("logs")}
                    disabled={!selectedGateway || runningCommand !== null}
                  >
                    Logs
                  </Button>
                </div>

                <label className="block space-y-2 text-sm">
                  <span className="text-zinc-400">Custom Remote Command</span>
                  <div className="flex gap-2">
                    <input
                      value={customCommand}
                      onChange={(event) => setCustomCommand(event.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none transition focus:border-blue-500"
                      placeholder="uname -a"
                    />
                    <Button
                      variant="outline"
                      onClick={() => void runCommand("custom")}
                      disabled={!selectedGateway || runningCommand !== null || !customCommand.trim()}
                    >
                      Run
                    </Button>
                  </div>
                </label>

                {runningCommand ? (
                  <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-200">
                    Running {buildCommandTitle(runningCommand).toLowerCase()}…
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="border-zinc-800 bg-zinc-950/80">
              <CardHeader>
                <CardTitle>Command Output</CardTitle>
                <CardDescription>
                  Last command result from the selected gateway.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {lastResult ? (
                  <>
                    <div className="grid gap-3 text-sm text-zinc-400 md:grid-cols-2">
                      <div>
                        <div className="text-zinc-500">Gateway</div>
                        <div className="font-mono text-zinc-100">{lastResult.connectionLabel}</div>
                      </div>
                      <div>
                        <div className="text-zinc-500">Result</div>
                        <div className={lastResult.ok ? "text-emerald-300" : "text-red-300"}>
                          {lastResult.ok ? "Success" : `Failed${lastResult.exitCode !== null ? ` (${lastResult.exitCode})` : ""}`}
                        </div>
                      </div>
                      <div>
                        <div className="text-zinc-500">Started</div>
                        <div className="text-zinc-100">{formatTimestamp(lastResult.startedAt)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-500">Finished</div>
                        <div className="text-zinc-100">{formatTimestamp(lastResult.finishedAt)}</div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">
                        Remote Command
                      </div>
                      <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-black/50 px-3 py-2 font-mono text-xs text-zinc-300">
                        {lastResult.remoteCommand}
                      </pre>
                    </div>
                    <div className="space-y-2">
                      <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">Output</div>
                      <pre className="max-h-[32rem] overflow-auto rounded-lg border border-zinc-800 bg-black px-3 py-3 font-mono text-xs leading-6 text-zinc-200 whitespace-pre-wrap">
                        {lastResult.combinedOutput || "Command returned no output."}
                      </pre>
                    </div>
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-sm text-zinc-500">
                    Run a command to see its stdout and stderr here.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
