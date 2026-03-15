import { useCallback, useMemo, useState } from 'react';
import { Toaster } from 'sonner';

import { buildBluetoothNodes } from '../data';
import { useDesktopRuntime } from '../runtime-context';
import { forgetApprovedNodeRules } from '../../lib/setup-rules';
import { CommandPalette } from './CommandPalette';
import { DashboardHeader } from './DashboardHeader';
import { BluetoothNode } from './BluetoothNode';
import { NodeDetailModal } from './NodeDetailModal';

export function Dashboard() {
  const {
    snapshot,
    setup,
    rescanAdapters,
    setAllowedNodes,
  } = useDesktopRuntime();
  const nodes = useMemo(
    () => (snapshot ? buildBluetoothNodes(snapshot) : []),
    [snapshot],
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (node) {
        setSelectedNodeId(node.id);
        setModalOpen(true);
      }
    },
    [nodes],
  );

  async function handleForgetNode(nodeId: string) {
    if (!setup) {
      return;
    }

    const nextRules = forgetApprovedNodeRules(setup.approvedNodes, nodeId);
    await setAllowedNodes(nextRules);

    if (selectedNodeId === nodeId) {
      setModalOpen(false);
      setSelectedNodeId(null);
    }
  }

  const activeNodes = nodes.filter((node) => node.isConnected).length;
  const movingNodes = nodes.filter((node) => node.isMoving && node.isConnected).length;

  return (
    <div className="size-full flex flex-col bg-black">
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#18181b',
            border: '1px solid #27272a',
            color: '#e4e4e7',
          },
        }}
      />
      <CommandPalette
        nodes={nodes}
        onScan={() => void rescanAdapters()}
        onSelectNode={handleSelectNode}
      />
      <NodeDetailModal node={selectedNode} open={modalOpen} onOpenChange={setModalOpen} />

      <DashboardHeader
        totalNodes={nodes.length}
        activeNodes={activeNodes}
        movingNodes={movingNodes}
        runtimeStatus={snapshot?.liveStatus ?? 'Starting gateway runtime…'}
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1800px] mx-auto mb-4 flex items-center justify-between">
          <div className="text-xs text-zinc-600 flex items-center gap-2">
            <div className="size-2 rounded-full bg-blue-400 animate-pulse" />
            Live runtime state
          </div>
          <div className="text-xs text-zinc-600 flex items-center gap-1.5">
            Press
            <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-400 text-[10px] font-mono">
              Ctrl+K
            </kbd>
            to search
          </div>
        </div>

        {snapshot?.runtimeState === 'restarting' && (
          <div className="max-w-[1800px] mx-auto mb-4 rounded-xl border border-blue-500/20 bg-blue-500/8 px-4 py-3 text-sm text-blue-300">
            Restarting gateway runtime. Keeping the last known device state on screen until the bridge reconnects.
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 max-w-[1800px] mx-auto">
          {nodes.map((node) => (
            <BluetoothNode
              key={node.id}
              node={node}
              onClick={() => handleSelectNode(node.id)}
              onForget={handleForgetNode}
            />
          ))}
        </div>
        {nodes.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-zinc-600">
            <p className="text-sm">No sensors configured. Go to Setup to add devices.</p>
          </div>
        )}
      </div>
    </div>
  );
}
