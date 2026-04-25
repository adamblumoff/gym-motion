import type {
  GatewayAdminCommand,
  GatewayAdminGateway,
} from "@core/services";

export const DEFAULT_SERVICE_NAME = "gym-motion-linux-gateway.service";
export const DEFAULT_PORT = 22;
export const DEFAULT_REPO_PATH = "~/gym-motion";

export function createGatewayDraft(): GatewayAdminGateway {
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

export function cloneGateway(gateway: GatewayAdminGateway | null) {
  return gateway ? { ...gateway } : null;
}

export function isGatewayValid(gateway: GatewayAdminGateway | null) {
  if (!gateway) {
    return false;
  }

  return (
    !!gateway.label.trim() &&
    !!((gateway.host?.trim() && gateway.user?.trim()) || gateway.sshHostAlias?.trim())
  );
}

export function formatTimestamp(value: string | null) {
  if (!value) {
    return "never";
  }

  return new Date(value).toLocaleString();
}

export function buildCommandTitle(command: GatewayAdminCommand) {
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

export function buildBootstrapCommand(gateway: GatewayAdminGateway | null) {
  const repoPath = gateway?.repoPath?.trim() || DEFAULT_REPO_PATH;
  return `cd ${repoPath} && bash ./scripts/linux-gateway/bootstrap-admin.sh`;
}

export function buildConnectionLabel(gateway: GatewayAdminGateway) {
  if (gateway.host && gateway.user) {
    return `${gateway.user}@${gateway.host}:${gateway.port}`;
  }

  return gateway.sshHostAlias || "connection not set";
}

export function buildSshPreview(gateway: GatewayAdminGateway | null) {
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
