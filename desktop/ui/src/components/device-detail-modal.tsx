import type { DeviceActivitySummary, GatewayRuntimeDeviceSummary } from "@core/contracts";

import { formatDelta, formatRelativeFromNow, formatRssi } from "../lib/formatters";

export function DeviceDetailModal({
  open,
  device,
  recentActivities,
  onClose,
}: {
  open: boolean;
  device: GatewayRuntimeDeviceSummary | null;
  recentActivities: DeviceActivitySummary[];
  onClose: () => void;
}) {
  if (!open || !device) {
    return null;
  }

  const now = Date.now();

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <section
        aria-modal="true"
        className="detail-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Node Detail</span>
            <h3>{device.machineLabel ?? device.id}</h3>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div className="summary-grid">
          <div>
            <span>Connection</span>
            <strong>{device.gatewayConnectionState}</strong>
          </div>
          <div>
            <span>Last Motion</span>
            <strong>{device.lastState}</strong>
          </div>
          <div>
            <span>Delta</span>
            <strong>{formatDelta(device.lastDelta)}</strong>
          </div>
          <div>
            <span>RSSI</span>
            <strong>{formatRssi(device.lastRssi)}</strong>
          </div>
          <div>
            <span>Telemetry</span>
            <strong>{formatRelativeFromNow(device.gatewayLastTelemetryAt, now)}</strong>
          </div>
          <div>
            <span>Firmware</span>
            <strong>{device.firmwareVersion}</strong>
          </div>
        </div>

        <div className="activity-list">
          {recentActivities.length === 0 ? (
            <p className="empty-copy">No recent activity recorded for this node.</p>
          ) : (
            recentActivities.slice(0, 8).map((activity) => (
              <article className="activity-row" key={activity.id}>
                <div>
                  <strong>{activity.title}</strong>
                  <p>{activity.message}</p>
                </div>
                <div className="activity-meta">
                  <span>{activity.code ?? activity.kind}</span>
                  <span>{formatRelativeFromNow(activity.receivedAt, now)}</span>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
