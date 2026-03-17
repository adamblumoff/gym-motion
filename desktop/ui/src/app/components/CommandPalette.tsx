import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Activity, BarChart3, Bluetooth, LayoutDashboard, Settings, Zap } from 'lucide-react';

import type { BluetoothNodeData } from '../selectors/types';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command';

interface CommandPaletteProps {
  nodes: BluetoothNodeData[];
  onSelectNode?: (nodeId: string) => void;
  onScan?: () => void;
}

export function CommandPalette({ nodes, onSelectNode, onScan }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search nodes, pages, actions..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          <CommandItem
            onSelect={() => {
              navigate('/');
              setOpen(false);
            }}
          >
            <LayoutDashboard className="mr-2 size-4 text-blue-400" />
            Dashboard
          </CommandItem>
          <CommandItem
            onSelect={() => {
              navigate('/analytics');
              setOpen(false);
            }}
          >
            <BarChart3 className="mr-2 size-4 text-blue-400" />
            Analytics
          </CommandItem>
          <CommandItem
            onSelect={() => {
              navigate('/setup');
              setOpen(false);
            }}
          >
            <Settings className="mr-2 size-4 text-blue-400" />
            Sensor Setup
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Nodes">
          {nodes.map((node) => (
            <CommandItem
              key={node.id}
              onSelect={() => {
                onSelectNode?.(node.id);
                setOpen(false);
              }}
            >
              <Bluetooth
                className={`mr-2 size-4 ${node.isConnected ? 'text-blue-400' : 'text-zinc-600'}`}
              />
              <span className="flex-1">{node.name}</span>
              <span className="text-xs text-zinc-500 font-mono">{node.macAddress ?? '--'}</span>
              {node.isMoving && <Activity className="ml-2 size-3.5 text-blue-400" />}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick Actions">
          <CommandItem
            onSelect={() => {
              onScan?.();
              navigate('/setup');
              setOpen(false);
            }}
          >
            <Zap className="mr-2 size-4 text-amber-400" />
            Scan for new devices
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
