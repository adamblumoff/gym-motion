import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { BarChart3, Bluetooth, LayoutDashboard, Settings, Zap } from 'lucide-react';

import type { BluetoothNodeData } from '../selectors/types';
import {
  connectionStatusLabel,
  motionStatusLabel,
  sensorStatusLabel,
} from '../selectors/node-status';
import { statusIconTextClassName, statusToneClassName } from './node-display';
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
              <Bluetooth className={`mr-2 size-4 ${statusIconTextClassName(node.visualTone)}`} />
              <span className="flex-1">{node.name}</span>
              <span className={`text-[11px] ${statusToneClassName(node.visualTone)}`}>
                {connectionStatusLabel(node.connectionStatus)}
                {" · "}
                {sensorStatusLabel(node.sensorStatus)}
                {" · "}
                {motionStatusLabel(node.motionStatus)}
              </span>
              <span className="text-xs text-zinc-500 font-mono">{node.macAddress ?? '--'}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {onScan ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Quick Actions">
              <CommandItem
                onSelect={() => {
                  onScan();
                  navigate('/setup');
                  setOpen(false);
                }}
              >
                <Zap className="mr-2 size-4 text-amber-400" />
                Scan for new devices
              </CommandItem>
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
