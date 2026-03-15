import type {
  DesktopSetupState,
  DesktopSnapshot,
  DiscoveredNodeSummary,
} from "@core/contracts";

import { formatRelativeFromNow, formatRssi } from "../lib/formatters";
import { resolveVisibleNodes } from "../lib/setup-rules";

function NodeRow({
  node,
  approved,
  now,
  onToggle,
}: {
  node: DiscoveredNodeSummary;
  approved: boolean;
  now: number;
  onToggle: (nodeId: string) => void;
}) {
  return (
    <article className="node-row" data-approved={approved}>
      <div className="node-copy">
        <div>
          <strong>{node.machineLabel ?? node.localName ?? node.knownDeviceId ?? node.id}</strong>
          <p>
            {node.gatewayConnectionState}
            {node.siteId ? ` · ${node.siteId}` : ""}
          </p>
        </div>
        <div className="node-meta">
          <span>{formatRelativeFromNow(node.lastSeenAt, now)}</span>
          <span>{formatRssi(node.lastRssi)}</span>
        </div>
      </div>

      <div className="node-details">
        {node.peripheralId ? <span className="card-pill">{node.peripheralId}</span> : null}
        {node.address ? <span className="card-pill">{node.address}</span> : null}
        {node.knownDeviceId ? <span className="card-pill accent">{node.knownDeviceId}</span> : null}
      </div>

      <button className="ghost-button" onClick={() => onToggle(node.id)} type="button">
        {approved ? "Remove" : "Connect"}
      </button>
    </article>
  );
}

export function SetupPage({
  setup,
  snapshot,
  now,
  onRefresh,
  onConnectNode,
  onRemoveNode,
}: {
  setup: DesktopSetupState;
  snapshot: DesktopSnapshot;
  now: number;
  onRefresh: () => void;
  onConnectNode: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
}) {
  const visibleNodes = resolveVisibleNodes(setup);

  return (
    <section className="page-shell">
      <section className="setup-banner">
        <article className="hero-panel">
          <span className="eyebrow">Node Provisioning</span>
          <h2>Manual Bluetooth discovery and machine approval.</h2>
          <p>
            Windows Bluetooth binding stays automatic. This screen only handles node
            discovery, approval, and removal.
          </p>
        </article>

        <div className="setup-actions">
          <button className="primary-button" onClick={onRefresh} type="button">
            Scan Nodes
          </button>
          <div className="setup-callout">
            <span className="eyebrow">Adapter</span>
            <strong>{setup.adapterIssue ?? snapshot.gateway.adapterState}</strong>
          </div>
        </div>
      </section>

      <section className="setup-grid">
        <article className="panel-glass">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Managed Nodes</span>
              <h3>{setup.approvedNodes.length} approved for this machine</h3>
            </div>
          </div>
          <p className="inline-summary">
            Bluetooth discovery is manual-only. Approving a node here determines what this
            machine is allowed to connect to when the runtime scans.
          </p>
        </article>

        <article className="panel-glass">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Visible Nodes</span>
              <h3>{visibleNodes.length} nodes currently visible</h3>
            </div>
          </div>

          <div className="node-list">
            {visibleNodes.length === 0 ? (
              <p className="empty-copy">
                No BLE nodes are visible right now. Power the sensor nearby, then run a scan.
              </p>
            ) : (
              visibleNodes.map((node) => {
                const approved = setup.approvedNodes.some((item) => item.id === node.id);
                return (
                  <NodeRow
                    approved={approved}
                    key={node.id}
                    node={node}
                    now={now}
                    onToggle={(nodeId) =>
                      approved ? onRemoveNode(nodeId) : onConnectNode(nodeId)
                    }
                  />
                );
              })
            )}
          </div>
        </article>
      </section>
    </section>
  );
}
