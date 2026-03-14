import { useEffect, useMemo, useState } from "react";

import type {
  ApprovedNodeRule,
  DesktopSetupState,
  DeviceActivitySummary,
  DeviceLogSummary,
  DiscoveredNodeSummary,
  GatewayRuntimeDeviceSummary,
  ThemePreference,
} from "@core/contracts";

import { useDesktopApp } from "./lib/use-desktop-app";

type Screen = "live" | "gateway" | "logs" | "setup";

const SCREENS: Array<{ id: Screen; label: string }> = [
  { id: "live", label: "Live" },
  { id: "gateway", label: "Gateway" },
  { id: "logs", label: "Logs" },
  { id: "setup", label: "Setup" },
];

const THEME_OPTIONS: ThemePreference[] = ["dark", "system", "light"];

function formatRelativeFromNow(value: string | null, now: number) {
  if (!value) {
    return "never";
  }

  const diffSeconds = Math.max(
    0,
    Math.round((now - new Date(value).getTime()) / 1000),
  );

  if (diffSeconds < 5) {
    return "now";
  }

  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  }

  if (diffSeconds < 3600) {
    return `${Math.round(diffSeconds / 60)}m`;
  }

  return `${Math.round(diffSeconds / 3600)}h`;
}

function formatThemePreference(preference: ThemePreference) {
  return preference[0]!.toUpperCase() + preference.slice(1);
}

function formatConnectionState(
  state: DiscoveredNodeSummary["gatewayConnectionState"],
) {
  if (state === "visible") {
    return "visible";
  }

  return state;
}

function Metric({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string | number;
  emphasis?: boolean;
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value" data-emphasis={emphasis}>
        {value}
      </span>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  formatLabel,
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
  formatLabel: (value: T) => string;
}) {
  return (
    <div aria-label={label} className="segmented-control" role="tablist">
      {options.map((option) => (
        <button
          aria-selected={option === value}
          className="segment"
          data-active={option === value}
          key={option}
          onClick={() => onChange(option)}
          role="tab"
          type="button"
        >
          {formatLabel(option)}
        </button>
      ))}
    </div>
  );
}

function DeviceRow({
  device,
  now,
}: {
  device: GatewayRuntimeDeviceSummary;
  now: number;
}) {
  return (
    <article className="device-row">
      <div className="device-primary">
        <span className="device-title">{device.machineLabel ?? device.id}</span>
        <span className="device-meta">
          {device.siteId ?? "Unassigned"} · {device.gatewayConnectionState}
        </span>
      </div>
      <div className="device-signal">{device.lastDelta ?? 0}</div>
      <div className="device-status" data-state={device.lastState}>
        {device.lastState}
      </div>
      <div className="device-meta-end">
        {formatRelativeFromNow(device.gatewayLastTelemetryAt, now)}
      </div>
    </article>
  );
}

function ActivityFeed({
  activities,
  now,
}: {
  activities: DeviceActivitySummary[];
  now: number;
}) {
  return (
    <div className="feed-list">
      {activities.slice(0, 10).map((activity) => (
        <article className="feed-row" key={activity.id}>
          <div className="feed-main">
            <span className="feed-title">{activity.title}</span>
            <span className="feed-copy">{activity.message}</span>
          </div>
          <div className="feed-side">
            <span>{activity.deviceId}</span>
            <span>{formatRelativeFromNow(activity.receivedAt, now)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function LogFeed({
  logs,
  now,
}: {
  logs: DeviceLogSummary[];
  now: number;
}) {
  return (
    <div className="feed-list">
      {logs.slice(0, 14).map((log) => (
        <article className="feed-row" key={log.id}>
          <div className="feed-main">
            <span className="feed-title">{log.code}</span>
            <span className="feed-copy">{log.message}</span>
          </div>
          <div className="feed-side">
            <span>{log.level}</span>
            <span>{formatRelativeFromNow(log.receivedAt, now)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function GatewayStatePanel({
  snapshot,
  now,
}: {
  snapshot: NonNullable<ReturnType<typeof useDesktopApp>["snapshot"]>;
  now: number;
}) {
  return (
    <section className="panel live-panel">
      <div className="section-heading">
        <span className="section-label">Connection status</span>
        <h2>Gateway is waiting for live BLE data</h2>
      </div>

      <div className="status-callout" data-state={snapshot.runtimeState}>
        <div className="status-callout-copy">
          <strong>{snapshot.liveStatus}</strong>
          <p>
            {snapshot.gatewayIssue ??
              "Use Setup to run a manual Bluetooth scan and connect a node."}
          </p>
        </div>
      </div>

      <div className="metric-grid">
        <Metric label="Bluetooth" value={snapshot.gateway.adapterState} />
        <Metric label="Scan state" value={snapshot.gateway.scanState} />
        <Metric label="Known nodes" value={snapshot.gateway.knownNodeCount} />
        <Metric
          label="Last advertisement"
          value={formatRelativeFromNow(snapshot.gateway.lastAdvertisementAt, now)}
        />
      </div>

      <div className="device-list compact">
        {snapshot.devices.length === 0 ? (
          <div className="empty-state">
            No approved nodes are connected yet. Open Setup and run a manual scan to connect a visible node.
          </div>
        ) : (
          snapshot.devices.map((device) => (
            <DeviceRow device={device} key={device.id} now={now} />
          ))
        )}
      </div>
    </section>
  );
}

function buildApprovedNodeRules(
  nodes: DiscoveredNodeSummary[],
  selectedIds: Iterable<string>,
  existingRules: ApprovedNodeRule[],
) {
  const existingById = new Map(existingRules.map((rule) => [rule.id, rule]));
  const nextRules: ApprovedNodeRule[] = [];

  for (const nodeId of selectedIds) {
    const visibleNode = nodes.find((node) => node.id === nodeId);

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

    const existingRule = existingById.get(nodeId);

    if (existingRule) {
      nextRules.push(existingRule);
    }
  }

  return nextRules;
}

function SetupPanel({
  setup,
  now,
  onRescanNodes,
  onSetNodes,
}: {
  setup: DesktopSetupState;
  now: number;
  onRescanNodes: () => Promise<void>;
  onSetNodes: (nodes: ApprovedNodeRule[]) => Promise<void>;
}) {
  const visibleNodes = useMemo(
    () =>
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
          })),
    [setup.approvedNodes, setup.nodes],
  );

  async function connectNode(node: DiscoveredNodeSummary) {
    const nextIds = new Set(setup.approvedNodes.map((approvedNode) => approvedNode.id));
    nextIds.add(node.id);
    await onSetNodes(buildApprovedNodeRules(visibleNodes, nextIds, setup.approvedNodes));
    await onRescanNodes();
  }

  async function removeNode(nodeId: string) {
    const nextIds = new Set(
      setup.approvedNodes
        .map((approvedNode) => approvedNode.id)
        .filter((approvedNodeId) => approvedNodeId !== nodeId),
    );
    await onSetNodes(buildApprovedNodeRules(visibleNodes, nextIds, setup.approvedNodes));
  }

  return (
    <section className="panel stack-panel">
      <div className="setup-header">
        <div className="section-heading">
          <div>
            <span className="section-label">Setup</span>
            <h2>Node connection control</h2>
          </div>
        </div>
        <div className="setup-actions">
          <button className="secondary-button" onClick={onRescanNodes} type="button">
            Scan nodes
          </button>
        </div>
      </div>

      {setup.adapterIssue ? (
        <div className="inline-issue">{setup.adapterIssue}</div>
      ) : null}

      <div className="setup-grid">
        <section className="setup-block">
          <div className="setup-block-heading">
            <span className="section-label">Visible nodes</span>
            <strong>Run a manual scan, then connect the node you want online.</strong>
          </div>

          <div className="setup-summary-row">
            <Metric label="Managed" value={setup.approvedNodes.length} />
            <Metric label="Visible" value={visibleNodes.length} />
            <Metric label="Bluetooth" value={setup.adapterIssue ? "issue" : "ready"} />
          </div>

          <div className="node-list">
            {visibleNodes.length === 0 ? (
              <div className="empty-state">
                No BLE nodes are visible yet. Keep the node powered nearby and start a manual scan if it just came online.
              </div>
            ) : (
              visibleNodes.map((node) => {
                const isManaged = setup.approvedNodes.some((approvedNode) => approvedNode.id === node.id);

                return (
                  <article className="node-card" data-approved={isManaged} key={node.id}>
                    <div className="node-main">
                      <div className="node-copy">
                        <span className="node-title">
                          {node.machineLabel ?? node.localName ?? node.knownDeviceId ?? node.id}
                        </span>
                        <span className="node-meta">
                          {formatConnectionState(node.gatewayConnectionState)}
                          {node.siteId ? ` · ${node.siteId}` : ""}
                        </span>
                      </div>
                      <div className="node-right">
                        <span className="detail-pill">
                          seen {formatRelativeFromNow(node.lastSeenAt, now)}
                        </span>
                        {node.lastRssi !== null ? (
                          <span className="detail-pill">RSSI {node.lastRssi}</span>
                        ) : null}
                        <button
                          className="secondary-button"
                          onClick={() =>
                            isManaged ? removeNode(node.id) : connectNode(node)
                          }
                          type="button"
                        >
                          {isManaged ? "Remove" : "Connect"}
                        </button>
                      </div>
                    </div>
                    <div className="node-detail-row">
                      {node.peripheralId ? (
                        <span className="detail-pill">PID {node.peripheralId}</span>
                      ) : null}
                      {node.address ? (
                        <span className="detail-pill">{node.address}</span>
                      ) : null}
                      {node.knownDeviceId ? (
                        <span className="detail-pill">{node.knownDeviceId}</span>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>
          <p className="setup-hint">
            Bluetooth discovery is manual-only. Start a scan whenever you want to find or reconnect nodes.
          </p>
        </section>
      </div>
    </section>
  );
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
  const [screen, setScreen] = useState<Screen>("live");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  if (!snapshot || !setup) {
    return <main className="loading-shell">Loading Gym Motion desktop…</main>;
  }

  const strongestDevice = snapshot.devices[0] ?? null;
  const connectedCount = snapshot.devices.filter(
    (device) => device.gatewayConnectionState === "connected",
  ).length;
  const showConnectionFirst =
    snapshot.runtimeState !== "running" || connectedCount === 0;

  return (
    <main className="app-shell">
      <header className="shell-header">
        <div className="brand-block">
          <div className="brand-mark">GM</div>
          <div>
            <div className="brand-title">Gym Motion</div>
            <div className="brand-subtitle">{snapshot.trayHint}</div>
          </div>
        </div>

        <nav className="nav-strip" aria-label="Primary">
          {SCREENS.map((item) => (
            <button
              className="nav-button"
              data-active={item.id === screen}
              key={item.id}
              onClick={() => setScreen(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="header-actions">
          <div className="status-cluster">
            <span className="status-pill">{snapshot.liveStatus}</span>
            <span className="status-pill subtle">{snapshot.gateway.scanState}</span>
          </div>
          <SegmentedControl
            formatLabel={formatThemePreference}
            label="Theme"
            onChange={(value) => void setThemePreference(value)}
            options={THEME_OPTIONS}
            value={theme.preference}
          />
          <button
            className="primary-button"
            onClick={() => void restartGatewayRuntime()}
            type="button"
          >
            Restart Gateway
          </button>
        </div>
      </header>

      <section className="top-strip">
        <Metric emphasis label="Connected" value={snapshot.gateway.connectedNodeCount} />
        <Metric label="Reconnecting" value={snapshot.gateway.reconnectingNodeCount} />
        <Metric label="Known nodes" value={snapshot.gateway.knownNodeCount} />
        <Metric label="Bluetooth" value={snapshot.gateway.adapterState} />
        {strongestDevice ? (
          <Metric
            emphasis
            label="Hottest machine"
            value={`${strongestDevice.machineLabel ?? strongestDevice.id} · ${strongestDevice.lastState}`}
          />
        ) : null}
      </section>

      {screen === "live" ? (
        <section className="dashboard-grid">
          {showConnectionFirst ? (
            <GatewayStatePanel now={now} snapshot={snapshot} />
          ) : (
            <section className="panel live-panel">
              <div className="section-heading">
                <span className="section-label">Live board</span>
                <h2>Fast machine state</h2>
              </div>

              <div className="device-list">
                {snapshot.devices.map((device) => (
                  <DeviceRow device={device} key={device.id} now={now} />
                ))}
              </div>
            </section>
          )}

          <section className="panel side-panel">
            <div className="section-heading">
              <span className="section-label">Activity</span>
              <h2>Latest runtime events</h2>
            </div>
            <ActivityFeed activities={snapshot.activities} now={now} />
          </section>
        </section>
      ) : null}

      {screen === "gateway" ? (
        <section className="dashboard-grid">
          <section className="panel">
            <div className="section-heading">
              <span className="section-label">Gateway</span>
              <h2>Runtime health</h2>
            </div>
            <div className="metric-grid">
              <Metric label="Runtime" value={snapshot.runtimeState} />
              <Metric label="Mode" value={snapshot.gateway.mode} />
              <Metric label="Host" value={snapshot.gateway.hostname} />
              <Metric label="Session" value={snapshot.gateway.sessionId.slice(0, 8)} />
              <Metric label="Bluetooth" value={snapshot.gateway.adapterState} />
              <Metric label="Scan state" value={snapshot.gateway.scanState} />
              <Metric label="Known nodes" value={snapshot.gateway.knownNodeCount} />
            </div>
            {snapshot.gatewayIssue ? (
              <div className="inline-issue">{snapshot.gatewayIssue}</div>
            ) : null}
          </section>

          <section className="panel side-panel">
            <div className="section-heading">
              <span className="section-label">Connections</span>
              <h2>Node status</h2>
            </div>
            <div className="device-list compact">
              {snapshot.devices.map((device) => (
                <DeviceRow device={device} key={device.id} now={now} />
              ))}
            </div>
          </section>
        </section>
      ) : null}

      {screen === "logs" ? (
        <section className="dashboard-grid single-column">
          <section className="panel">
            <div className="section-heading">
              <span className="section-label">Logs</span>
              <h2>Gateway and node messages</h2>
            </div>
            <LogFeed logs={snapshot.logs} now={now} />
          </section>
        </section>
      ) : null}

      {screen === "setup" ? (
        <section className="dashboard-grid single-column">
          <SetupPanel
            now={now}
            onRescanNodes={() => rescanAdapters()}
            onSetNodes={(nodes) => setAllowedNodes(nodes)}
            setup={setup}
          />
        </section>
      ) : null}
    </main>
  );
}
