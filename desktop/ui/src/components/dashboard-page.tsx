import type {
  DesktopSetupState,
  DeviceActivitySummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
} from "@core/contracts";

import {
  formatDelta,
  formatRelativeFromNow,
  formatRssi,
  summarizeDeviceSignal,
} from "../lib/formatters";

function DeviceCard({
  device,
  now,
  onOpen,
}: {
  device: GatewayRuntimeDeviceSummary;
  now: number;
  onOpen: (device: GatewayRuntimeDeviceSummary) => void;
}) {
  return (
    <article className="device-card" data-state={device.gatewayConnectionState}>
      <div className="device-card-header">
        <div className="device-icon">{device.lastState === "moving" ? "M" : "S"}</div>
        <div>
          <h3>{device.machineLabel ?? device.id}</h3>
          <p>{device.siteId ?? device.advertisedName ?? "Unassigned node"}</p>
        </div>
        <div className="device-status-cluster">
          <span className="card-pill">{device.gatewayConnectionState}</span>
          <span className="card-pill accent">{device.healthStatus}</span>
        </div>
      </div>

      <dl className="device-stats">
        <div>
          <dt>Motion</dt>
          <dd>{device.lastState}</dd>
        </div>
        <div>
          <dt>Delta</dt>
          <dd>{formatDelta(device.lastDelta)}</dd>
        </div>
        <div>
          <dt>Telemetry</dt>
          <dd>{formatRelativeFromNow(device.gatewayLastTelemetryAt, now)}</dd>
        </div>
        <div>
          <dt>Signal</dt>
          <dd>{summarizeDeviceSignal(device)}</dd>
        </div>
      </dl>

      <div className="device-bars" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => {
          const strength = Math.max(
            16,
            78 -
              index * 6 -
              Math.max(0, Math.min(38, Math.abs(device.lastRssi ?? -74) - 44)),
          );

          return (
            <span
              className="device-bar"
              key={index}
              style={{ height: `${strength}%` }}
            />
          );
        })}
      </div>

      <div className="device-card-footer">
        <span>{formatRssi(device.lastRssi)}</span>
        <span>{device.firmwareVersion}</span>
        <button className="ghost-button" onClick={() => onOpen(device)} type="button">
          Inspect
        </button>
      </div>
    </article>
  );
}

export function DashboardPage({
  devices,
  recentActivities,
  gateway,
  gatewayIssue,
  runtimeState,
  setup,
  now,
  connectedCount,
  disconnectedCount,
  onOpenDevice,
}: {
  devices: GatewayRuntimeDeviceSummary[];
  recentActivities: DeviceActivitySummary[];
  gateway: GatewayStatusSummary;
  gatewayIssue: string | null;
  runtimeState: "starting" | "running" | "degraded";
  setup: DesktopSetupState;
  now: number;
  connectedCount: number;
  disconnectedCount: number;
  onOpenDevice: (device: GatewayRuntimeDeviceSummary) => void;
}) {
  return (
    <section className="page-shell">
      <section className="hero-band">
        <article className="hero-panel">
          <span className="eyebrow">Fleet Overview</span>
          <h2>Bluetooth control room with live machine telemetry.</h2>
          <p>
            The dashboard renders directly from the managed gateway runtime. Devices
            shown here are the real nodes connected to this operator machine.
          </p>
        </article>

        <div className="hero-metrics">
          <article className="overview-card">
            <span>Connected</span>
            <strong>{connectedCount}</strong>
            <p>Nodes actively streaming to the gateway.</p>
          </article>
          <article className="overview-card">
            <span>Standby</span>
            <strong>{disconnectedCount}</strong>
            <p>Known devices not currently connected.</p>
          </article>
          <article className="overview-card">
            <span>Scan State</span>
            <strong>{gateway.scanState}</strong>
            <p>Bluetooth adapter {gateway.adapterState}.</p>
          </article>
        </div>
      </section>

      <section className="dashboard-grid">
        <section className="panel-stack">
          <article className="panel-glass gateway-health-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Gateway Health</span>
                <h3>{runtimeState === "running" ? "Gateway live" : "Attention needed"}</h3>
              </div>
              <span className="card-pill accent">{gateway.mode}</span>
            </div>

            <div className="health-matrix">
              <div>
                <span>Session</span>
                <strong>{gateway.sessionId.slice(0, 8)}</strong>
              </div>
              <div>
                <span>Managed Nodes</span>
                <strong>{setup.approvedNodes.length}</strong>
              </div>
              <div>
                <span>Last Advertisement</span>
                <strong>{formatRelativeFromNow(gateway.lastAdvertisementAt, now)}</strong>
              </div>
              <div>
                <span>Reconnect Queue</span>
                <strong>{gateway.reconnectingNodeCount}</strong>
              </div>
            </div>

            <p className="inline-summary">
              {gatewayIssue ??
                "Manual scan remains the only discovery action. Setup is where nodes are approved or removed."}
            </p>
          </article>

          <article className="panel-glass">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Recent Activity</span>
                <h3>Newest lifecycle and motion events</h3>
              </div>
            </div>
            <div className="activity-list">
              {recentActivities.length === 0 ? (
                <p className="empty-copy">No runtime activity has been recorded yet.</p>
              ) : (
                recentActivities.slice(0, 6).map((activity) => (
                  <article className="activity-row" key={activity.id}>
                    <div>
                      <strong>{activity.title}</strong>
                      <p>{activity.message}</p>
                    </div>
                    <div className="activity-meta">
                      <span>{activity.deviceId}</span>
                      <span>{formatRelativeFromNow(activity.receivedAt, now)}</span>
                    </div>
                  </article>
                ))
              )}
            </div>
          </article>
        </section>

        <section className="device-grid">
          {devices.length === 0 ? (
            <article className="empty-panel">
              <h3>No connected nodes yet</h3>
              <p>
                Approve a device in Setup, then run a manual scan to bring it online in this
                dashboard.
              </p>
            </article>
          ) : (
            devices.map((device) => (
              <DeviceCard device={device} key={device.id} now={now} onOpen={onOpenDevice} />
            ))
          )}
        </section>
      </section>
    </section>
  );
}
