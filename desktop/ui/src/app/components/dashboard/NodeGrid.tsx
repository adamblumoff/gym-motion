import type { BluetoothNodeData } from "../../selectors/types";
import { BluetoothNode } from "../BluetoothNode";

type NodeGridProps = {
  nodes: BluetoothNodeData[];
  pendingForgetNodeIds: Set<string>;
  pendingResumeNodeIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
  onRequestForgetNode: (nodeId: string) => void;
  onKeepNode: (nodeId: string) => void;
};

export function NodeGrid({
  nodes,
  pendingForgetNodeIds,
  pendingResumeNodeIds,
  onSelectNode,
  onRequestForgetNode,
  onKeepNode,
}: NodeGridProps) {
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-zinc-600">
        <p className="text-sm">No sensors configured. Go to Setup to add devices.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 max-w-[1800px] mx-auto">
      {nodes.map((node) => (
        <BluetoothNode
          key={node.id}
          node={node}
          onClick={() => onSelectNode(node.id)}
          onRequestForget={onRequestForgetNode}
          onKeepDevice={onKeepNode}
          forgetPending={pendingForgetNodeIds.has(node.id)}
          keepPending={pendingResumeNodeIds.has(node.id)}
        />
      ))}
    </div>
  );
}
