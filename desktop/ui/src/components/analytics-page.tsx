import type {
  DesktopSetupState,
  DeviceActivitySummary,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  GatewayStatusSummary,
  MotionEventSummary,
} from "@core/contracts";

import { formatRelativeFromNow } from "../lib/formatters";

function buildEventBuckets(events: MotionEventSummary[]) {
  if (events.length === 0) {
    return [];
  }

  const byDevice = new Map<string, number>();
  for (const event of events) {
    byDevice.set(event.deviceId, (byDevice.get(event.deviceId) ?? 0) + 1);
  }

  return [...byDevice.entries()]
    .map(([deviceId, count]) => ({ deviceId, count }))
    .toSorted((left, right) => right.count - left.count)
    .slice(0, 6);
}

export function AnalyticsPage({
  snapshotDevices,
  recentActivities,
  recentEvents,
  logs,
  gateway,
  runtimeState,
  setup,
  now,
  onOpenDeviceById,
}: {
  snapshotDevices: GatewayRuntimeDeviceSummary[];
  recentActivities: DeviceActivitySummary[];
  recentEvents: MotionEventSummary[];
  logs: DeviceLogSummary[];
  gateway: GatewayStatusSummary;
  runtimeState: "starting" | "running" | "degraded";
  setup: DesktopSetupState;
  now: number;
  onOpenDeviceById: (deviceId: string) => void;
}) {
  const busiestDevices = buildEventBuckets(recentEvents);
  const warnLogs = logs.filter((log) => log.level !== "info");
  const managedConnectedRatio = `${gateway.connectedNodeCount}/${setup.approvedNodes.length || 0}`;

  return (
    <section className="page-shell">
      <section className="analytics-grid">
        <article className="panel-glass analytics-summary">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Analytics</span>
              <h3>Real runtime summaries only</h3>
            </div>
          </div>

          <div className="summary-grid">
            <div>
              <span>Runtime</span>
              <strong>{runtimeState}</strong>
            </div>
            <div>
              <span>Connected Ratio</span>
              <strong>{managedConnectedRatio}</strong>
            </div>
            <div>
              <span>Recent Motion Events</span>
              <strong>{recentEvents.length}</strong>
            </div>
            <div>
              <span>Warn or Error Logs</span>
              <strong>{warnLogs.length}</strong>
            </div>
          </div>
        </article>

        <article className="panel-glass analytics-chart-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Motion Density</span>
              <h3>Devices with the most recent event traffic</h3>
            </div>
          </div>
          <div className="bar-list">
            {busiestDevices.length === 0 ? (
              <p className="empty-copy">Recent motion data has not arrived yet.</p>
            ) : (
              busiestDevices.map((entry) => {
                const width = Math.max(
                  18,
                  Math.round((entry.count / busiestDevices[0]!.count) * 100),
                );

                return (
                  <button
                    className="bar-row"
                    key={entry.deviceId}
                    onClick={() => onOpenDeviceById(entry.deviceId)}
                    type="button"
                  >
                    <span>{entry.deviceId}</span>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${width}%` }} />
                    </span>
                    <strong>{entry.count}</strong>
                  </button>
                );
              })
            )}
          </div>
        </article>

        <article className="panel-glass">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Lifecycle Feed</span>
              <h3>Recent gateway and node activity</h3>
            </div>
          </div>
          <div className="activity-list">
            {recentActivities.length === 0 ? (
              <p className="empty-copy">No activity available yet.</p>
            ) : (
              recentActivities.slice(0, 10).map((activity) => (
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

        <article className="panel-glass">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Node Registry</span>
              <h3>Known devices in the runtime snapshot</h3>
            </div>
          </div>
          <div className="registry-list">
            {snapshotDevices.length === 0 ? (
              <p className="empty-copy">No device summary records available.</p>
            ) : (
              snapshotDevices.map((device) => (
                <button
                  className="registry-row"
                  key={device.id}
                  onClick={() => onOpenDeviceById(device.id)}
                  type="button"
                >
                  <div>
                    <strong>{device.machineLabel ?? device.id}</strong>
                    <p>{device.siteId ?? device.gatewayConnectionState}</p>
                  </div>
                  <div className="activity-meta">
                    <span>{device.lastState}</span>
                    <span>{device.firmwareVersion}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </article>
      </section>
    </section>
  );
}
