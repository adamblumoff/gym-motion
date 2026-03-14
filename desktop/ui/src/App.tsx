import { useEffect, useState } from "react";

import type {
  DesktopEnvironment,
  DesktopSnapshot,
  DeviceActivitySummary,
  DeviceLogSummary,
  GatewayRuntimeDeviceSummary,
  MotionEventSummary,
} from "@core/contracts";

type Screen = "gateway" | "live" | "logs" | "setup";

const SCREENS: Array<{ id: Screen; label: string }> = [
  { id: "gateway", label: "Gateway" },
  { id: "live", label: "Live" },
  { id: "logs", label: "Logs" },
  { id: "setup", label: "Setup" },
];

function formatRelative(isoValue: string | null) {
  if (!isoValue) {
    return "Never";
  }

  const diffMs = Date.now() - new Date(isoValue).getTime();
  const diffSeconds = Math.max(0, Math.round(diffMs / 1000));

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  if (diffSeconds < 3600) {
    return `${Math.round(diffSeconds / 60)}m ago`;
  }

  return `${Math.round(diffSeconds / 3600)}h ago`;
}

function formatEnvironment(environment: DesktopEnvironment) {
  return environment === "local" ? "LOCAL" : "PRODUCTION DATA";
}

function DeviceCard({ device }: { device: GatewayRuntimeDeviceSummary }) {
  return (
    <article className="card device-card">
      <div className="card-header">
        <div>
          <p className="eyebrow">{device.siteId ?? "Unassigned zone"}</p>
          <h3>{device.machineLabel ?? device.id}</h3>
        </div>
        <span className={`state-badge state-${device.lastState}`}>
          {device.lastState.toUpperCase()}
        </span>
      </div>

      <dl className="stat-grid">
        <div>
          <dt>Connection</dt>
          <dd>{device.gatewayConnectionState}</dd>
        </div>
        <div>
          <dt>RSSI</dt>
          <dd>{device.lastRssi ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Firmware</dt>
          <dd>{device.firmwareVersion}</dd>
        </div>
        <div>
          <dt>Last telemetry</dt>
          <dd>{formatRelative(device.gatewayLastTelemetryAt)}</dd>
        </div>
      </dl>
    </article>
  );
}

function ActivityList({ activities }: { activities: DeviceActivitySummary[] }) {
  return (
    <div className="list">
      {activities.map((activity) => (
        <article className="list-row" key={activity.id}>
          <div>
            <div className="row-title">{activity.title}</div>
            <div className="row-copy">{activity.message}</div>
          </div>
          <div className="row-meta">
            <span>{activity.deviceId}</span>
            <span>{formatRelative(activity.receivedAt)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function EventList({ events }: { events: MotionEventSummary[] }) {
  return (
    <div className="list">
      {events.map((event) => (
        <article className="list-row" key={event.id}>
          <div>
            <div className="row-title">{event.deviceId}</div>
            <div className="row-copy">
              Motion state changed to {event.state} with delta {event.delta ?? 0}.
            </div>
          </div>
          <div className="row-meta">
            <span>{event.firmwareVersion ?? "unknown"}</span>
            <span>{formatRelative(event.receivedAt)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function LogList({ logs }: { logs: DeviceLogSummary[] }) {
  return (
    <div className="list">
      {logs.map((log) => (
        <article className="list-row" key={log.id}>
          <div>
            <div className="row-title">
              {log.code} <span className="muted">[{log.level}]</span>
            </div>
            <div className="row-copy">{log.message}</div>
          </div>
          <div className="row-meta">
            <span>{log.deviceId}</span>
            <span>{formatRelative(log.receivedAt)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function EnvironmentToggle({
  environment,
  onChange,
}: {
  environment: DesktopEnvironment;
  onChange: (value: DesktopEnvironment) => void;
}) {
  return (
    <div className="environment-toggle">
      {(["local", "production-data"] as DesktopEnvironment[]).map((option) => (
        <button
          className="ghost-button"
          data-active={option === environment}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {formatEnvironment(option)}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>("gateway");
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);

  useEffect(() => {
    let mounted = true;

    void window.gymMotionDesktop.getSnapshot().then((nextSnapshot) => {
      if (mounted) {
        setSnapshot(nextSnapshot);
      }
    });

    const unsubscribe = window.gymMotionDesktop.subscribe((event) => {
      setSnapshot(event.snapshot);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function handleEnvironmentChange(environment: DesktopEnvironment) {
    const nextSnapshot = await window.gymMotionDesktop.setEnvironment(environment);
    setSnapshot(nextSnapshot);
  }

  if (!snapshot) {
    return <main className="loading-shell">Loading Gym Motion desktop…</main>;
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="hero-kicker">Gym Motion Desktop</p>
          <h1>One Windows app for the gateway, live board, and operator workflow.</h1>
          <p className="hero-body">
            This first desktop cut keeps the gateway alive in the tray and replaces
            localhost HTTP plus SSE with an internal desktop runtime bridge.
          </p>
        </div>

        <div className="hero-side">
          <span className={`environment-badge env-${snapshot.environment}`}>
            {formatEnvironment(snapshot.environment)}
          </span>
          <span className="live-pill">{snapshot.liveStatus}</span>
          <p className="tray-note">{snapshot.trayHint}</p>
          <EnvironmentToggle
            environment={snapshot.environment}
            onChange={handleEnvironmentChange}
          />
        </div>
      </section>

      <section className="topbar">
        <nav className="nav-strip">
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

        <button
          className="primary-button"
          onClick={() => void window.gymMotionDesktop.triggerDemoBurst()}
          type="button"
        >
          Simulate Motion Burst
        </button>
      </section>

      {screen === "gateway" ? (
        <section className="content-grid gateway-grid">
          <article className="card overview-card">
            <p className="eyebrow">Gateway Health</p>
            <h2>{snapshot.gateway.mode}</h2>
            <dl className="stat-grid">
              <div>
                <dt>Host</dt>
                <dd>{snapshot.gateway.hostname}</dd>
              </div>
              <div>
                <dt>Adapter</dt>
                <dd>{snapshot.gateway.adapterState}</dd>
              </div>
              <div>
                <dt>Connected nodes</dt>
                <dd>{snapshot.gateway.connectedNodeCount}</dd>
              </div>
              <div>
                <dt>Last advertisement</dt>
                <dd>{formatRelative(snapshot.gateway.lastAdvertisementAt)}</dd>
              </div>
            </dl>
          </article>

          <article className="card">
            <p className="eyebrow">Runtime Timeline</p>
            <h2>Recent activity</h2>
            <ActivityList activities={snapshot.activities.slice(0, 8)} />
          </article>
        </section>
      ) : null}

      {screen === "live" ? (
        <section className="content-grid">
          <div className="device-grid">
            {snapshot.devices.map((device) => (
              <DeviceCard device={device} key={device.id} />
            ))}
          </div>

          <article className="card">
            <p className="eyebrow">Latest Motion</p>
            <h2>Live event feed</h2>
            <EventList events={snapshot.events} />
          </article>
        </section>
      ) : null}

      {screen === "logs" ? (
        <section className="content-grid logs-grid">
          <article className="card">
            <p className="eyebrow">Device Logs</p>
            <h2>Gateway and node messages</h2>
            <LogList logs={snapshot.logs} />
          </article>
        </section>
      ) : null}

      {screen === "setup" ? (
        <section className="content-grid setup-grid">
          <article className="card">
            <p className="eyebrow">Provisioning Direction</p>
            <h2>Desktop setup flow target</h2>
            <p className="section-copy">
              The next porting step is replacing the old browser-only Web Bluetooth
              setup flow with a desktop provisioning adapter behind the Electron bridge.
            </p>
            <ul className="flat-list">
              <li>Renderer stays UI-only and requests provisioning through preload.</li>
              <li>Main process owns adapter selection and native capability checks.</li>
              <li>Node BLE remains preferred, with a Rust sidecar seam preserved.</li>
            </ul>
          </article>

          <article className="card">
            <p className="eyebrow">Legacy Archive</p>
            <h2>What moved</h2>
            <p className="section-copy">
              The former Next.js app, API routes, and gateway prototype now live under
              <code>legacy/</code> so the desktop app can evolve without pretending to be
              a localhost web deployment.
            </p>
          </article>
        </section>
      ) : null}
    </main>
  );
}
