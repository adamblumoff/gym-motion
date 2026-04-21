import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { app } from "electron";

import type { GatewayAdminConfig, GatewayAdminGateway } from "@core/services";

const DEFAULT_SERVICE_NAME = "gym-motion-linux-gateway.service";
const DEFAULT_PORT = 22;
const DEFAULT_REPO_PATH = "~/gym-motion";

export type GatewayAdminStore = {
  getConfig: () => GatewayAdminConfig;
  saveConfig: (config: GatewayAdminConfig) => GatewayAdminConfig;
};

function readConfig(filePath: string): GatewayAdminConfig {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as GatewayAdminConfig;
    return normalizeConfig(parsed);
  } catch {
    return { gateways: [] };
  }
}

function normalizeGateway(gateway: Partial<GatewayAdminGateway>): GatewayAdminGateway | null {
  const id = gateway.id?.trim();
  const label = gateway.label?.trim();
  const sshHostAlias = gateway.sshHostAlias?.trim() || null;
  const host = gateway.host?.trim() || null;
  const user = gateway.user?.trim() || null;
  const port =
    typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : DEFAULT_PORT;
  const serviceName = gateway.serviceName?.trim() || DEFAULT_SERVICE_NAME;
  const repoPath = gateway.repoPath?.trim() || DEFAULT_REPO_PATH;
  const notes = gateway.notes?.trim() ?? null;

  if (!id || !label || (!sshHostAlias && !(host && user))) {
    return null;
  }

  return {
    id,
    label,
    sshHostAlias,
    host,
    user,
    port,
    serviceName,
    repoPath,
    notes,
  };
}

function normalizeConfig(config: GatewayAdminConfig): GatewayAdminConfig {
  const gateways = config.gateways
    .map((gateway) => normalizeGateway(gateway))
    .filter((gateway): gateway is GatewayAdminGateway => gateway !== null);

  return { gateways };
}

export function createGatewayAdminStore(): GatewayAdminStore {
  const filePath = path.join(app.getPath("userData"), "gateway-admin.json");

  function writeConfig(config: GatewayAdminConfig) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(config, null, 2));
  }

  return {
    getConfig() {
      return readConfig(filePath);
    },
    saveConfig(config) {
      const normalized = normalizeConfig(config);
      writeConfig(normalized);
      return normalized;
    },
  };
}
