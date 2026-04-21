import { execFile } from "node:child_process";

import { ipcMain } from "electron";

import {
  DESKTOP_GATEWAY_ADMIN_CHANNELS,
  type GatewayAdminCommand,
  type GatewayAdminCommandResult,
  type GatewayAdminConfig,
  type GatewayAdminGateway,
  type GatewayAdminReadinessCheck,
  type GatewayAdminReadinessResult,
  type RunGatewayAdminCommandInput,
} from "@core/services";
import type { GatewayAdminStore } from "./gateway-admin-store";

const DEFAULT_TIMEOUT_MS = 15_000;

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, `'"'"'`) + "'";
}

function normalizeRemotePath(path: string) {
  if (path === "~") {
    return "$HOME";
  }

  if (path.startsWith("~/")) {
    return `$HOME/${path.slice(2)}`;
  }

  return shellQuote(path);
}

function buildRemoteCommand(
  command: GatewayAdminCommand,
  serviceName: string,
  customCommand?: string,
) {
  switch (command) {
    case "status":
      return `sudo -n systemctl status --no-pager ${shellQuote(serviceName)}`;
    case "start":
      return `sudo -n systemctl start ${shellQuote(serviceName)}`;
    case "stop":
      return `sudo -n systemctl stop ${shellQuote(serviceName)}`;
    case "restart":
      return `sudo -n systemctl restart ${shellQuote(serviceName)}`;
    case "logs":
      return `sudo -n journalctl -u ${shellQuote(serviceName)} -n 200 --no-pager`;
    case "custom": {
      const trimmed = customCommand?.trim();
      if (!trimmed) {
        throw new Error("Enter a remote command to run.");
      }
      return trimmed;
    }
  }
}

function resolveConnection(gateway: GatewayAdminGateway) {
  if (gateway.host && gateway.user) {
    return {
      args: ["-p", String(gateway.port), "-l", gateway.user, gateway.host],
      label: `${gateway.user}@${gateway.host}:${gateway.port}`,
    };
  }

  if (gateway.sshHostAlias) {
    return {
      args: [gateway.sshHostAlias],
      label: gateway.sshHostAlias,
    };
  }

  throw new Error("Gateway is missing connection details.");
}

function runLocalCommand(command: string, args: string[]) {
  return new Promise<{
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            ok: true,
            exitCode: 0,
            stdout,
            stderr,
          });
          return;
        }

        const nodeError = error as NodeJS.ErrnoException & { code?: number | string };
        resolve({
          ok: false,
          exitCode: typeof nodeError.code === "number" ? nodeError.code : null,
          stdout,
          stderr:
            stderr ||
            (nodeError.code === "ENOENT"
              ? `${command} was not found on this machine.`
              : nodeError.message),
        });
      },
    );
  });
}

function createSshArgs(gateway: GatewayAdminGateway, remoteCommand: string, batchMode = true) {
  const connection = resolveConnection(gateway);
  return {
    connectionLabel: connection.label,
    args: [
      "-T",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=5",
      ...(batchMode ? (["-o", "BatchMode=yes"] as const) : []),
      ...connection.args,
      remoteCommand,
    ],
  };
}

async function runSshCommand(
  gateway: GatewayAdminGateway,
  remoteCommand: string,
  batchMode = true,
) {
  const ssh = createSshArgs(gateway, remoteCommand, batchMode);
  const result = await runLocalCommand("ssh", ssh.args);
  return {
    ...result,
    connectionLabel: ssh.connectionLabel,
  };
}

function combineOutput(stdout: string, stderr: string) {
  if (stdout && stderr) {
    return `${stdout.trimEnd()}\n\n[stderr]\n${stderr.trimEnd()}`.trim();
  }

  return (stdout || stderr).trim();
}

function createCheck(
  key: GatewayAdminReadinessCheck["key"],
  label: string,
  ok: boolean,
  detail: string,
): GatewayAdminReadinessCheck {
  return { key, label, ok, detail };
}

async function checkReadiness(gateway: GatewayAdminGateway): Promise<GatewayAdminReadinessResult> {
  const checks: GatewayAdminReadinessCheck[] = [];
  const bootstrapCommand = `cd ${gateway.repoPath} && ./scripts/linux-gateway/bootstrap-admin.sh`;

  const sshClient = await runLocalCommand("ssh", ["-V"]);
  checks.push(
    createCheck(
      "ssh-client",
      "OpenSSH client",
      sshClient.ok,
      sshClient.ok ? "OpenSSH is available on this Windows machine." : combineOutput(sshClient.stdout, sshClient.stderr),
    ),
  );

  const sshAgent = await runLocalCommand("ssh-add", ["-l"]);
  checks.push(
    createCheck(
      "ssh-agent",
      "SSH key agent",
      sshAgent.ok,
      sshAgent.ok
        ? "An SSH key is loaded in the local agent."
        : "No usable SSH key is loaded. Start ssh-agent and run ssh-add on your key.",
    ),
  );

  const connectionProbe = await runSshCommand(gateway, "printf ready");
  checks.push(
    createCheck(
      "ssh-connect",
      "SSH connection",
      connectionProbe.ok && connectionProbe.stdout.includes("ready"),
      connectionProbe.ok
        ? `Connected successfully as ${connectionProbe.connectionLabel}.`
        : combineOutput(connectionProbe.stdout, connectionProbe.stderr),
    ),
  );

  const repoProbe = await runSshCommand(
    gateway,
    `test -d ${normalizeRemotePath(gateway.repoPath)} && printf present`,
  );
  checks.push(
    createCheck(
      "repo-path",
      "Gateway repo path",
      repoProbe.ok && repoProbe.stdout.includes("present"),
      repoProbe.ok && repoProbe.stdout.includes("present")
        ? `Found repo at ${gateway.repoPath}.`
        : `Expected repo at ${gateway.repoPath}.`,
    ),
  );

  const sudoStatusProbe = await runSshCommand(
    gateway,
    `sudo -n systemctl status --no-pager ${shellQuote(gateway.serviceName)} >/dev/null && printf ready`,
  );
  checks.push(
    createCheck(
      "service-control",
      "Passwordless service control",
      sudoStatusProbe.ok && sudoStatusProbe.stdout.includes("ready"),
      sudoStatusProbe.ok && sudoStatusProbe.stdout.includes("ready")
        ? "sudo service control is ready."
        : `Run once on the gateway: ${bootstrapCommand}`,
    ),
  );

  const logsProbe = await runSshCommand(
    gateway,
    `sudo -n journalctl -u ${shellQuote(gateway.serviceName)} -n 1 --no-pager >/dev/null && printf ready`,
  );
  checks.push(
    createCheck(
      "logs",
      "Gateway log access",
      logsProbe.ok && logsProbe.stdout.includes("ready"),
      logsProbe.ok && logsProbe.stdout.includes("ready")
        ? "Gateway logs can be read without a prompt."
        : `Run once on the gateway: ${bootstrapCommand}`,
    ),
  );

  const connectionLabel = resolveConnection(gateway).label;

  return {
    gatewayId: gateway.id,
    checkedAt: new Date().toISOString(),
    overallOk: checks.every((check) => check.ok),
    connectionLabel,
    bootstrapCommand,
    checks,
  };
}

export function registerGatewayAdminBridge(store: GatewayAdminStore) {
  ipcMain.handle(DESKTOP_GATEWAY_ADMIN_CHANNELS.getConfig, () => store.getConfig());
  ipcMain.handle(
    DESKTOP_GATEWAY_ADMIN_CHANNELS.saveConfig,
    (_event, config: GatewayAdminConfig) => store.saveConfig(config),
  );
  ipcMain.handle(
    DESKTOP_GATEWAY_ADMIN_CHANNELS.runCommand,
    async (_event, input: RunGatewayAdminCommandInput): Promise<GatewayAdminCommandResult> => {
      const config = store.getConfig();
      const gateway = config.gateways.find((entry) => entry.id === input.gatewayId);

      if (!gateway) {
        throw new Error("Gateway not found.");
      }

      const remoteCommand = buildRemoteCommand(
        input.command,
        gateway.serviceName,
        input.customCommand,
      );
      const startedAt = new Date().toISOString();
      const result = await runSshCommand(gateway, remoteCommand);
      const finishedAt = new Date().toISOString();

      return {
        gatewayId: gateway.id,
        command: input.command,
        connectionLabel: result.connectionLabel,
        remoteCommand,
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        combinedOutput: combineOutput(result.stdout, result.stderr),
        startedAt,
        finishedAt,
      };
    },
  );
  ipcMain.handle(
    DESKTOP_GATEWAY_ADMIN_CHANNELS.checkReadiness,
    async (_event, gatewayId: string) => {
      const config = store.getConfig();
      const gateway = config.gateways.find((entry) => entry.id === gatewayId);

      if (!gateway) {
        throw new Error("Gateway not found.");
      }

      return checkReadiness(gateway);
    },
  );

  return {
    dispose() {
      ipcMain.removeHandler(DESKTOP_GATEWAY_ADMIN_CHANNELS.getConfig);
      ipcMain.removeHandler(DESKTOP_GATEWAY_ADMIN_CHANNELS.saveConfig);
      ipcMain.removeHandler(DESKTOP_GATEWAY_ADMIN_CHANNELS.runCommand);
      ipcMain.removeHandler(DESKTOP_GATEWAY_ADMIN_CHANNELS.checkReadiness);
    },
  };
}
