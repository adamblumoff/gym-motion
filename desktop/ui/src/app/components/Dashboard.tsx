import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toaster } from 'sonner';

import { buildBluetoothNodes } from '../data';
import { useDesktopRuntime } from '../runtime-context';
import {
  forgetApprovedNodeRules,
  matchesApprovedNodeIdentity,
} from '../../lib/setup-rules';
import { CommandPalette } from './CommandPalette';
import { DashboardHeader } from './DashboardHeader';
import { BluetoothNode } from './BluetoothNode';
import { NodeDetailModal } from './NodeDetailModal';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';

const SILENT_RECONNECT_INTERVAL_MS = 10_000;
const FORGET_PROMPT_DELAY_MS = 20_000;

export function Dashboard() {
  const {
    snapshot,
    setup,
    rescanAdapters,
    requestSilentReconnect,
    setAllowedNodes,
  } = useDesktopRuntime();
  const nodes = useMemo(
    () => (snapshot ? buildBluetoothNodes(snapshot) : []),
    [snapshot],
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [forgetPromptNodeIds, setForgetPromptNodeIds] = useState<string[]>([]);
  const disconnectStartedAtRef = useRef(new Map<string, number>());
  const lastReconnectAttemptAtRef = useRef(new Map<string, number>());
  const promptedNodeIdsRef = useRef(new Set<string>());
  const reconnectInFlightRef = useRef(false);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const forgetPromptNodeId = forgetPromptNodeIds[0] ?? null;
  const forgetPromptNode = nodes.find((node) => node.id === forgetPromptNodeId) ?? null;

  const approvedDisconnectedDeviceIds = useMemo(() => {
    if (!snapshot || !setup) {
      return [];
    }

    return snapshot.devices
      .filter((device) => {
        if (device.gatewayConnectionState !== 'disconnected') {
          return false;
        }

        return setup.approvedNodes.some(
          (rule) =>
            rule.id === device.id ||
            matchesApprovedNodeIdentity(rule, {
              peripheralId: device.peripheralId,
              address: null,
              localName: device.advertisedName,
              knownDeviceId: device.id,
            }),
        );
      })
      .map((device) => ({
        id: device.id,
        disconnectedAt: device.gatewayLastDisconnectedAt
          ? Date.parse(device.gatewayLastDisconnectedAt)
          : Date.now(),
      }));
  }, [setup, snapshot]);

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

  const dismissForgetPrompt = useCallback((nodeId: string) => {
    promptedNodeIdsRef.current.add(nodeId);
    setForgetPromptNodeIds((current) => current.filter((id) => id !== nodeId));
  }, []);

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

    dismissForgetPrompt(nodeId);
  }

  useEffect(() => {
    const approvedDisconnectedIds = new Set(
      approvedDisconnectedDeviceIds.map((device) => device.id),
    );

    for (const [deviceId] of disconnectStartedAtRef.current) {
      if (!approvedDisconnectedIds.has(deviceId)) {
        disconnectStartedAtRef.current.delete(deviceId);
        lastReconnectAttemptAtRef.current.delete(deviceId);
        promptedNodeIdsRef.current.delete(deviceId);
        setForgetPromptNodeIds((current) => current.filter((id) => id !== deviceId));
      }
    }

    for (const device of approvedDisconnectedDeviceIds) {
      if (!disconnectStartedAtRef.current.has(device.id)) {
        disconnectStartedAtRef.current.set(device.id, device.disconnectedAt);
      }
    }
  }, [approvedDisconnectedDeviceIds]);

  useEffect(() => {
    if (approvedDisconnectedDeviceIds.length === 0) {
      return;
    }

    const timer = setInterval(() => {
      const now = Date.now();
      let shouldRequestSilentReconnect = false;

      for (const device of approvedDisconnectedDeviceIds) {
        const startedAt =
          disconnectStartedAtRef.current.get(device.id) ?? device.disconnectedAt;
        disconnectStartedAtRef.current.set(device.id, startedAt);

        const lastAttemptAt = lastReconnectAttemptAtRef.current.get(device.id) ?? 0;
        if (now - lastAttemptAt >= SILENT_RECONNECT_INTERVAL_MS) {
          lastReconnectAttemptAtRef.current.set(device.id, now);
          shouldRequestSilentReconnect = true;
        }

        if (
          now - startedAt >= FORGET_PROMPT_DELAY_MS &&
          !promptedNodeIdsRef.current.has(device.id)
        ) {
          promptedNodeIdsRef.current.add(device.id);
          setForgetPromptNodeIds((current) =>
            current.includes(device.id) ? current : [...current, device.id],
          );
        }
      }

      if (!shouldRequestSilentReconnect || reconnectInFlightRef.current) {
        return;
      }

      reconnectInFlightRef.current = true;
      void requestSilentReconnect().finally(() => {
        reconnectInFlightRef.current = false;
      });
    }, 1_000);

    return () => {
      clearInterval(timer);
    };
  }, [approvedDisconnectedDeviceIds, requestSilentReconnect]);

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
      <Dialog
        open={forgetPromptNode !== null}
        onOpenChange={(open) => {
          if (!open && forgetPromptNodeId) {
            dismissForgetPrompt(forgetPromptNodeId);
          }
        }}
      >
        <DialogContent className="max-w-md border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Do you want to forget this device?</DialogTitle>
            <DialogDescription className="text-zinc-400">
              {forgetPromptNode
                ? `${forgetPromptNode.name} has stayed disconnected during silent Bluetooth reconnect attempts.`
                : 'This device has stayed disconnected during silent Bluetooth reconnect attempts.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row justify-end gap-2">
            <Button
              variant="ghost"
              className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              onClick={() => {
                if (forgetPromptNodeId) {
                  dismissForgetPrompt(forgetPromptNodeId);
                }
              }}
            >
              Keep Device
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (forgetPromptNodeId) {
                  void handleForgetNode(forgetPromptNodeId);
                }
              }}
            >
              Forget Device
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
