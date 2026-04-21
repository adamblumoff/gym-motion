import { useEffect, useMemo, useState } from 'react';
import { toast, Toaster } from 'sonner';

import { buildBluetoothNodes } from '../selectors/dashboard';
import { useDesktopRuntime } from '../runtime-context';
import { CommandPalette } from './CommandPalette';
import { ConfirmationDialog } from './ConfirmationDialog';
import { NodeDetailModal } from './NodeDetailModal';
import { NodeGrid } from './dashboard/NodeGrid';
import { RuntimeBanner } from './dashboard/RuntimeBanner';

type ForgetTarget = {
  id: string;
  name: string;
};

function addToSet(current: Set<string>, value: string) {
  const next = new Set(current);
  next.add(value);
  return next;
}

function removeFromSet(current: Set<string>, value: string) {
  const next = new Set(current);
  next.delete(value);
  return next;
}

export function Dashboard() {
  const {
    snapshot,
    setup,
    startManualScan,
    forgetNode,
    resumeReconnectForNode,
  } = useDesktopRuntime();
  const [pendingResumeNodeIds, setPendingResumeNodeIds] = useState<Set<string>>(new Set());
  const [pendingForgetNodeIds, setPendingForgetNodeIds] = useState<Set<string>>(new Set());
  const [forgetTarget, setForgetTarget] = useState<ForgetTarget | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const nodes = useMemo(
    () => (snapshot ? buildBluetoothNodes(snapshot, setup?.approvedNodes ?? []) : []),
    [setup?.approvedNodes, snapshot],
  );

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  useEffect(() => {
    if (!forgetTarget) {
      return;
    }

    if (!nodes.some((node) => node.id === forgetTarget.id)) {
      setForgetTarget(null);
    }
  }, [forgetTarget, nodes]);

  useEffect(() => {
    setPendingResumeNodeIds((current) => {
      const next = new Set(
        Array.from(current).filter((nodeId) => {
          const node = nodes.find((item) => item.id === nodeId);
          return node?.reconnectAwaitingDecision === true;
        }),
      );
      return next.size === current.size ? current : next;
    });

    setPendingForgetNodeIds((current) => {
      const next = new Set(
        Array.from(current).filter((nodeId) => nodes.some((item) => item.id === nodeId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [nodes]);

  function handleSelectNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) {
      return;
    }

    setSelectedNodeId(node.id);
    setModalOpen(true);
  }

  function requestForgetNode(nodeId: string) {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) {
      return;
    }

    setForgetTarget({
      id: node.id,
      name: node.name,
    });
  }

  async function confirmForgetNode() {
    if (!forgetTarget) {
      return;
    }

    const nodeId = forgetTarget.id;
    setPendingForgetNodeIds((current) => addToSet(current, nodeId));

    try {
      await forgetNode(nodeId);
      setForgetTarget(null);
      toast.success('Device forgotten.');

      if (selectedNodeId === nodeId) {
        setModalOpen(false);
        setSelectedNodeId(null);
      }
    } catch (error) {
      setPendingForgetNodeIds((current) => removeFromSet(current, nodeId));
      toast.error(error instanceof Error ? error.message : 'Failed to forget device.');
    }
  }

  async function handleKeepNode(nodeId: string) {
    setPendingResumeNodeIds((current) => addToSet(current, nodeId));

    try {
      await resumeReconnectForNode(nodeId);
      toast.success('Resuming reconnect scan.');
    } catch (error) {
      setPendingResumeNodeIds((current) => removeFromSet(current, nodeId));
      toast.error(error instanceof Error ? error.message : 'Failed to resume reconnect scan.');
    }
  }

  const forgetPending = forgetTarget ? pendingForgetNodeIds.has(forgetTarget.id) : false;
  const runtimeStatus = snapshot?.liveStatus ?? 'Starting gateway runtime…';
  const gatewayIssue = snapshot?.gatewayIssue ?? null;
  const isCloudMode = setup?.adapterIssue?.startsWith('Cloud mode is active.') ?? false;

  return (
    <>
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
        onScan={isCloudMode ? undefined : () => void startManualScan()}
        onSelectNode={handleSelectNode}
      />
      <NodeDetailModal node={selectedNode} open={modalOpen} onOpenChange={setModalOpen} />
      <ConfirmationDialog
        open={forgetTarget !== null}
        title="Forget this device?"
        description={`This removes ${forgetTarget?.name ?? 'this sensor'} from approved devices and stops automatic reconnect attempts until you pair it again.`}
        confirmLabel="Forget Device"
        pending={forgetPending}
        onOpenChange={(open) => {
          if (!open && !forgetPending) {
            setForgetTarget(null);
          }
        }}
        onConfirm={() => void confirmForgetNode()}
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1800px] mx-auto mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-zinc-100 text-balance">{runtimeStatus}</div>
            {gatewayIssue ? (
              <div className="mt-1 text-xs text-amber-300 text-pretty">{gatewayIssue}</div>
            ) : null}
          </div>
          <div className="shrink-0 text-xs text-zinc-600 flex items-center gap-2">
            <div className="size-2 rounded-full bg-blue-400 animate-pulse" />
            Live runtime state
          </div>
          <div className="shrink-0 text-xs text-zinc-600 flex items-center gap-1.5">
            Press
            <kbd className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-400 text-[10px] font-mono">
              Ctrl+K
            </kbd>
            to search
          </div>
        </div>

        <RuntimeBanner runtimeState={snapshot?.runtimeState} />
        <NodeGrid
          nodes={nodes}
          pendingForgetNodeIds={pendingForgetNodeIds}
          pendingResumeNodeIds={pendingResumeNodeIds}
          onSelectNode={handleSelectNode}
          onRequestForgetNode={requestForgetNode}
          onKeepNode={(nodeId) => void handleKeepNode(nodeId)}
        />
      </div>
    </>
  );
}
