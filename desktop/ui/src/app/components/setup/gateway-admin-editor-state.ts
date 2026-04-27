import type {
  GatewayAdminCommand,
  GatewayAdminCommandResult,
  GatewayAdminConfig,
  GatewayAdminGateway,
  GatewayAdminReadinessResult,
} from "@core/services";

import { cloneGateway, createGatewayDraft, isGatewayValid } from "./gateway-admin-utils";

export type GatewayEditorMode = "edit" | "create";

export type GatewayAdminEditorState = {
  config: GatewayAdminConfig | null;
  selectedGatewayId: string | null;
  mode: GatewayEditorMode;
  draft: GatewayAdminGateway | null;
  returnGatewayId: string | null;
  lastResult: GatewayAdminCommandResult | null;
  readiness: GatewayAdminReadinessResult | null;
  isSaving: boolean;
  deletingGatewayId: string | null;
  pendingDeleteGatewayId: string | null;
  runningCommand: GatewayAdminCommand | null;
  checkingReadiness: boolean;
};

export const initialGatewayAdminEditorState: GatewayAdminEditorState = {
  config: null,
  selectedGatewayId: null,
  mode: "edit",
  draft: null,
  returnGatewayId: null,
  lastResult: null,
  readiness: null,
  isSaving: false,
  deletingGatewayId: null,
  pendingDeleteGatewayId: null,
  runningCommand: null,
  checkingReadiness: false,
};

function findGateway(config: GatewayAdminConfig | null, gatewayId: string | null) {
  return gatewayId ? config?.gateways.find((gateway) => gateway.id === gatewayId) ?? null : null;
}

function syncFromConfig(
  state: GatewayAdminEditorState,
  config: GatewayAdminConfig,
  selectedGatewayId: string | null,
): GatewayAdminEditorState {
  const selectedGateway = findGateway(config, selectedGatewayId) ?? config.gateways[0] ?? null;

  return {
    ...state,
    config,
    selectedGatewayId: selectedGateway?.id ?? null,
    mode: "edit",
    draft: cloneGateway(selectedGateway),
    returnGatewayId: null,
  };
}

export function loadGatewayAdminConfig(config: GatewayAdminConfig): GatewayAdminEditorState {
  return syncFromConfig(initialGatewayAdminEditorState, config, config.gateways[0]?.id ?? null);
}

export function getPersistedSelectedGateway(state: GatewayAdminEditorState) {
  return findGateway(state.config, state.selectedGatewayId);
}

export function isCreateMode(state: GatewayAdminEditorState) {
  return state.mode === "create";
}

export function isEditorDirty(state: GatewayAdminEditorState) {
  if (!state.draft) {
    return false;
  }

  if (isCreateMode(state)) {
    return true;
  }

  const persisted = getPersistedSelectedGateway(state);
  return persisted ? JSON.stringify(state.draft) !== JSON.stringify(persisted) : false;
}

export function canSaveGateway(state: GatewayAdminEditorState) {
  return Boolean(
    state.draft &&
      isGatewayValid(state.draft) &&
      (isCreateMode(state) || isEditorDirty(state)),
  );
}

export function filterGatewayAdminGateways(
  config: GatewayAdminConfig | null,
  searchQuery: string,
) {
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
}

export function patchGatewayDraft<TKey extends keyof GatewayAdminGateway>(
  state: GatewayAdminEditorState,
  field: TKey,
  value: GatewayAdminGateway[TKey],
): GatewayAdminEditorState {
  return state.draft
    ? {
        ...state,
        draft: {
          ...state.draft,
          [field]: value,
        },
      }
    : state;
}

export function startCreateGateway(state: GatewayAdminEditorState): GatewayAdminEditorState | null {
  if (isCreateMode(state) || isEditorDirty(state)) {
    return null;
  }

  return {
    ...state,
    returnGatewayId: state.selectedGatewayId,
    mode: "create",
    draft: createGatewayDraft(),
    readiness: null,
  };
}

export function selectGateway(
  state: GatewayAdminEditorState,
  gatewayId: string,
): GatewayAdminEditorState | null {
  const selectedGateway = findGateway(state.config, gatewayId);
  if (!selectedGateway || isCreateMode(state) || isEditorDirty(state)) {
    return null;
  }

  return {
    ...state,
    selectedGatewayId: selectedGateway.id,
    mode: "edit",
    draft: cloneGateway(selectedGateway),
    readiness: state.readiness?.gatewayId === selectedGateway.id ? state.readiness : null,
  };
}

export function cancelGatewayEditing(state: GatewayAdminEditorState): GatewayAdminEditorState {
  if (isCreateMode(state)) {
    const selectedGatewayId = state.returnGatewayId ?? state.config?.gateways[0]?.id ?? null;

    return {
      ...state,
      selectedGatewayId,
      mode: "edit",
      draft: cloneGateway(findGateway(state.config, selectedGatewayId)),
      returnGatewayId: null,
      readiness: null,
    };
  }

  return {
    ...state,
    draft: cloneGateway(getPersistedSelectedGateway(state)),
  };
}

export function buildGatewayAdminConfigForSave(state: GatewayAdminEditorState) {
  if (!state.config || !state.draft || !canSaveGateway(state)) {
    return null;
  }

  return isCreateMode(state)
    ? { gateways: [...state.config.gateways, state.draft] }
    : {
        gateways: state.config.gateways.map((gateway) =>
          gateway.id === state.draft?.id ? state.draft : gateway,
        ),
      };
}

export function applySavedGatewayAdminConfig(
  state: GatewayAdminEditorState,
  config: GatewayAdminConfig,
  selectedGatewayId: string | null,
): GatewayAdminEditorState {
  return {
    ...syncFromConfig(state, config, selectedGatewayId),
    lastResult: null,
    readiness: null,
    isSaving: false,
  };
}

export function requestDeleteGateway(
  state: GatewayAdminEditorState,
  gatewayId: string,
): GatewayAdminEditorState | null {
  if (isCreateMode(state) || isEditorDirty(state)) {
    return null;
  }

  return {
    ...state,
    pendingDeleteGatewayId: gatewayId,
  };
}

export function applyDeletedGatewayAdminConfig(
  state: GatewayAdminEditorState,
  config: GatewayAdminConfig,
  deletedGatewayId: string,
): GatewayAdminEditorState {
  const selectedGatewayId =
    state.selectedGatewayId === deletedGatewayId
      ? config.gateways[0]?.id ?? null
      : state.selectedGatewayId;

  return {
    ...syncFromConfig(state, config, selectedGatewayId),
    lastResult: state.lastResult?.gatewayId === deletedGatewayId ? null : state.lastResult,
    readiness: state.readiness?.gatewayId === deletedGatewayId ? null : state.readiness,
    deletingGatewayId: null,
    pendingDeleteGatewayId: null,
  };
}
