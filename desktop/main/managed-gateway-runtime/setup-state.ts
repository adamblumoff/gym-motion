import type {
  ApprovedNodeRule,
} from "@core/contracts";

export function normalizeApprovedNodes(
  store: { getJson: <T>(key: string) => T | null | undefined },
  key: string,
) {
  const nodes = store.getJson<ApprovedNodeRule[]>(key);

  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.filter((node) => typeof node?.id === "string");
}

export function dedupeApprovedNodes(nodes: ApprovedNodeRule[]) {
  const byId = new Map<string, ApprovedNodeRule>();

  for (const node of nodes) {
    byId.set(node.id, node);
  }

  return [...byId.values()];
}
