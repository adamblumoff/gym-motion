import { useEffect, useMemo, useState } from "react";

import type {
  ApprovedNodeRule,
  DesktopSetupState,
  GatewayRuntimeDeviceSummary,
  ThemePreference,
} from "@core/contracts";

import { AnalyticsPage } from "./components/analytics-page";
import { CommandPalette } from "./components/command-palette";
import { DashboardPage } from "./components/dashboard-page";
import { DeviceDetailModal } from "./components/device-detail-modal";
import { Header } from "./components/header";
import { SetupPage } from "./components/setup-page";
import { useDesktopApp } from "./lib/use-desktop-app";

export type AppRoute = "dashboard" | "setup" | "analytics";

const ROUTES: Array<{ id: AppRoute; label: string; badge?: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "setup", label: "Setup" },
  { id: "analytics", label: "Analytics" },
];

const THEME_OPTIONS: ThemePreference[] = ["dark", "system", "light"];

function buildApprovedNodeRules(
  setup: DesktopSetupState,
  selectedIds: Iterable<string>,
): ApprovedNodeRule[] {
  const visibleNodes =
    setup.nodes.length > 0
      ? setup.nodes
      : setup.approvedNodes.map((node) => ({
          id: node.id,
          label: node.label,
          peripheralId: node.peripheralId,
          address: node.address,
          localName: node.localName,
          knownDeviceId: node.knownDeviceId,
          machineLabel: null,
          siteId: null,
          lastRssi: null,
          lastSeenAt: null,
          gatewayConnectionState: "visible" as const,
          isApproved: true,
        }));
  const existingById = new Map(setup.approvedNodes.map((rule) => [rule.id, rule]));
  const nextRules: ApprovedNodeRule[] = [];

  for (const id of selectedIds) {
    const visibleNode = visibleNodes.find((node) => node.id === id);

    if (visibleNode) {
      nextRules.push({
        id: visibleNode.id,
        label: visibleNode.label,
        peripheralId: visibleNode.peripheralId,
        address: visibleNode.address,
        localName: visibleNode.localName,
        knownDeviceId: visibleNode.knownDeviceId,
      });
      continue;
    }

    const existing = existingById.get(id);
    if (existing) {
      nextRules.push(existing);
    }
  }

  return nextRules;
}

export function App() {
  const {
    snapshot,
    setup,
    theme,
    setThemePreference,
    restartGatewayRuntime,
    rescanAdapters,
    setAllowedNodes,
  } = useDesktopApp();
  const [route, setRoute] = useState<AppRoute>("dashboard");
  const [now, setNow] = useState(() => Date.now());
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((current) => !current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!snapshot || !setup) {
    return <main className="loading-shell">Loading Gym Motion desktop...</main>;
  }

  const resolvedSnapshot = snapshot;
  const resolvedSetup = setup;

  const selectedDevice =
    resolvedSnapshot.devices.find((device) => device.id === selectedDeviceId) ?? null;
  const connectedCount = resolvedSnapshot.devices.filter(
    (device) => device.gatewayConnectionState === "connected",
  ).length;
  const disconnectedCount = resolvedSnapshot.devices.length - connectedCount;
  const routeBadges = {
    dashboard: `${resolvedSnapshot.devices.length}`,
    setup: `${resolvedSetup.approvedNodes.length}`,
    analytics: `${resolvedSnapshot.activities.length}`,
  } satisfies Record<AppRoute, string>;

  const headerMetrics = useMemo(
    () => [
      {
        label: "Live Nodes",
        value: String(resolvedSnapshot.gateway.connectedNodeCount),
        tone: "accent" as const,
      },
      {
        label: "Managed",
        value: String(resolvedSetup.approvedNodes.length),
        tone: "default" as const,
      },
      {
        label: "Signals",
        value: resolvedSnapshot.liveStatus,
        tone:
          resolvedSnapshot.runtimeState === "running"
            ? ("success" as const)
            : ("warn" as const),
      },
    ],
    [
      resolvedSetup.approvedNodes.length,
      resolvedSnapshot.gateway.connectedNodeCount,
      resolvedSnapshot.liveStatus,
      resolvedSnapshot.runtimeState,
    ],
  );

  async function connectNode(nodeId: string) {
    const nextIds = new Set(resolvedSetup.approvedNodes.map((node) => node.id));
    nextIds.add(nodeId);
    await setAllowedNodes(buildApprovedNodeRules(resolvedSetup, nextIds));
    await rescanAdapters();
  }

  async function removeNode(nodeId: string) {
    const nextIds = new Set(
      resolvedSetup.approvedNodes.map((node) => node.id).filter((id) => id !== nodeId),
    );
    await setAllowedNodes(buildApprovedNodeRules(resolvedSetup, nextIds));
  }

  function openDevice(device: GatewayRuntimeDeviceSummary) {
    setSelectedDeviceId(device.id);
  }

  return (
    <main className="app-shell">
      <Header
        metrics={headerMetrics}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onRouteChange={setRoute}
        route={route}
        routes={ROUTES.map((item) => ({
          ...item,
          badge: routeBadges[item.id],
        }))}
        theme={theme}
      />

      {route === "dashboard" ? (
        <DashboardPage
          connectedCount={connectedCount}
          devices={resolvedSnapshot.devices}
          disconnectedCount={disconnectedCount}
          gateway={resolvedSnapshot.gateway}
          gatewayIssue={resolvedSnapshot.gatewayIssue}
          now={now}
          onOpenDevice={openDevice}
          recentActivities={resolvedSnapshot.activities}
          runtimeState={resolvedSnapshot.runtimeState}
          setup={resolvedSetup}
        />
      ) : null}

      {route === "setup" ? (
        <SetupPage
          now={now}
          onConnectNode={(nodeId) => void connectNode(nodeId)}
          onRefresh={() => void rescanAdapters()}
          onRemoveNode={(nodeId) => void removeNode(nodeId)}
          setup={resolvedSetup}
          snapshot={resolvedSnapshot}
        />
      ) : null}

      {route === "analytics" ? (
        <AnalyticsPage
          gateway={resolvedSnapshot.gateway}
          logs={resolvedSnapshot.logs}
          now={now}
          onOpenDeviceById={(deviceId) => {
            const device = resolvedSnapshot.devices.find((item) => item.id === deviceId);
            if (device) {
              openDevice(device);
            }
          }}
          recentActivities={resolvedSnapshot.activities}
          recentEvents={resolvedSnapshot.events}
          runtimeState={resolvedSnapshot.runtimeState}
          setup={resolvedSetup}
          snapshotDevices={resolvedSnapshot.devices}
        />
      ) : null}

      <DeviceDetailModal
        device={selectedDevice}
        onClose={() => setSelectedDeviceId(null)}
        open={selectedDevice !== null}
        recentActivities={resolvedSnapshot.activities.filter(
          (activity) => activity.deviceId === selectedDevice?.id,
        )}
      />

      <CommandPalette
        onClose={() => setCommandPaletteOpen(false)}
        onOpenDevice={(deviceId) => {
          const device = resolvedSnapshot.devices.find((item) => item.id === deviceId);
          if (device) {
            openDevice(device);
            setCommandPaletteOpen(false);
          }
        }}
        onRefresh={() => void rescanAdapters()}
        onRestartGateway={() => void restartGatewayRuntime()}
        onRouteChange={(nextRoute) => {
          setRoute(nextRoute);
          setCommandPaletteOpen(false);
        }}
        onThemeChange={(preference) => void setThemePreference(preference)}
        open={commandPaletteOpen}
        routes={ROUTES}
        selectedTheme={theme.preference}
        themeOptions={THEME_OPTIONS}
        visibleDevices={resolvedSnapshot.devices}
      />
    </main>
  );
}
