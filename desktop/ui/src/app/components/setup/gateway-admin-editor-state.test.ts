import { describe, expect, it } from "vitest";

import type {
  GatewayAdminCommandResult,
  GatewayAdminConfig,
  GatewayAdminReadinessResult,
} from "@core/services";

import {
  applyDeletedGatewayAdminConfig,
  applySavedGatewayAdminConfig,
  buildGatewayAdminConfigForSave,
  canSaveGateway,
  cancelGatewayEditing,
  getPersistedSelectedGateway,
  isEditorDirty,
  loadGatewayAdminConfig,
  patchGatewayDraft,
  requestDeleteGateway,
  selectGateway,
  startCreateGateway,
} from "./gateway-admin-editor-state";

const config = {
  gateways: [
    {
      id: "zone-a",
      label: "Zone A",
      sshHostAlias: null,
      host: "192.168.1.10",
      user: "adam",
      port: 22,
      serviceName: "gym-motion-linux-gateway.service",
      repoPath: "~/gym-motion",
      notes: null,
    },
    {
      id: "zone-b",
      label: "Zone B",
      sshHostAlias: "zone-b",
      host: null,
      user: null,
      port: 22,
      serviceName: "gym-motion-linux-gateway.service",
      repoPath: "~/gym-motion",
      notes: null,
    },
  ],
} satisfies GatewayAdminConfig;

describe("gateway admin editor state", () => {
  it("loads the first gateway as the editable selection", () => {
    const state = loadGatewayAdminConfig(config);

    expect(getPersistedSelectedGateway(state)?.id).toBe("zone-a");
    expect(state.draft).toEqual(config.gateways[0]);
    expect(isEditorDirty(state)).toBe(false);
    expect(canSaveGateway(state)).toBe(false);
  });

  it("blocks selection and deletion while the current gateway has unsaved edits", () => {
    const dirtyState = patchGatewayDraft(
      loadGatewayAdminConfig(config),
      "label",
      "Unsaved Zone A",
    );

    expect(isEditorDirty(dirtyState)).toBe(true);
    expect(selectGateway(dirtyState, "zone-b")).toBeNull();
    expect(requestDeleteGateway(dirtyState, "zone-a")).toBeNull();
  });

  it("creates a valid gateway config from a draft and clears command/readiness state after save", () => {
    const creating = startCreateGateway(loadGatewayAdminConfig(config));
    expect(creating).not.toBeNull();

    const withHost = patchGatewayDraft(creating!, "host", "192.168.1.44");
    const withUser = patchGatewayDraft(withHost, "user", "adam");
    const nextConfig = buildGatewayAdminConfigForSave(withUser);

    expect(nextConfig?.gateways).toHaveLength(3);
    expect(nextConfig?.gateways[2]).toMatchObject({
      label: "New Gateway",
      host: "192.168.1.44",
      user: "adam",
    });

    const commandResult = {
      gatewayId: "zone-a",
      command: "status",
      connectionLabel: "adam@192.168.1.10:22",
      remoteCommand: "systemctl status",
      ok: true,
      exitCode: 0,
      stdout: "ready",
      stderr: "",
      combinedOutput: "ready",
      startedAt: "2026-04-26T00:00:00.000Z",
      finishedAt: "2026-04-26T00:00:01.000Z",
    } satisfies GatewayAdminCommandResult;
    const readiness = {
      gatewayId: "zone-a",
      checkedAt: "2026-04-26T00:00:01.000Z",
      overallOk: true,
      connectionLabel: "adam@192.168.1.10:22",
      bootstrapCommand: "cd ~/gym-motion && ./scripts/linux-gateway/bootstrap-admin.sh",
      checks: [],
    } satisfies GatewayAdminReadinessResult;
    const saved = applySavedGatewayAdminConfig(
      {
        ...withUser,
        lastResult: commandResult,
        readiness,
        isSaving: true,
      },
      nextConfig!,
      nextConfig!.gateways[2]!.id,
    );

    expect(saved.selectedGatewayId).toBe(nextConfig!.gateways[2]!.id);
    expect(saved.lastResult).toBeNull();
    expect(saved.readiness).toBeNull();
    expect(saved.isSaving).toBe(false);
  });

  it("cancels a new gateway draft back to the previous selection", () => {
    const creating = startCreateGateway(loadGatewayAdminConfig(config));
    const cancelled = cancelGatewayEditing(creating!);

    expect(cancelled.selectedGatewayId).toBe("zone-a");
    expect(cancelled.draft).toEqual(config.gateways[0]);
    expect(isEditorDirty(cancelled)).toBe(false);
  });

  it("selects a surviving gateway and clears stale output after delete", () => {
    const commandResult = {
      gatewayId: "zone-a",
      command: "status",
      connectionLabel: "adam@192.168.1.10:22",
      remoteCommand: "systemctl status",
      ok: true,
      exitCode: 0,
      stdout: "ready",
      stderr: "",
      combinedOutput: "ready",
      startedAt: "2026-04-26T00:00:00.000Z",
      finishedAt: "2026-04-26T00:00:01.000Z",
    } satisfies GatewayAdminCommandResult;
    const readiness = {
      gatewayId: "zone-a",
      checkedAt: "2026-04-26T00:00:01.000Z",
      overallOk: true,
      connectionLabel: "adam@192.168.1.10:22",
      bootstrapCommand: "cd ~/gym-motion && ./scripts/linux-gateway/bootstrap-admin.sh",
      checks: [],
    } satisfies GatewayAdminReadinessResult;
    const state = {
      ...loadGatewayAdminConfig(config),
      lastResult: commandResult,
      readiness,
      deletingGatewayId: "zone-a",
      pendingDeleteGatewayId: "zone-a",
    };
    const savedConfig = { gateways: [config.gateways[1]!] };

    const nextState = applyDeletedGatewayAdminConfig(state, savedConfig, "zone-a");

    expect(nextState.selectedGatewayId).toBe("zone-b");
    expect(nextState.draft).toEqual(config.gateways[1]);
    expect(nextState.lastResult).toBeNull();
    expect(nextState.readiness).toBeNull();
    expect(nextState.deletingGatewayId).toBeNull();
    expect(nextState.pendingDeleteGatewayId).toBeNull();
  });
});
