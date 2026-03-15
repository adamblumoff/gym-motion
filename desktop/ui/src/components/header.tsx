import type { ThemeState } from "@core/services";

import type { AppRoute } from "../App";

type HeaderMetric = {
  label: string;
  value: string;
  tone: "default" | "accent" | "success" | "warn";
};

export function Header({
  route,
  routes,
  onRouteChange,
  onOpenCommandPalette,
  metrics,
  theme,
}: {
  route: AppRoute;
  routes: Array<{ id: AppRoute; label: string; badge?: string }>;
  onRouteChange: (route: AppRoute) => void;
  onOpenCommandPalette: () => void;
  metrics: HeaderMetric[];
  theme: ThemeState;
}) {
  return (
    <header className="dashboard-header">
      <div className="brand-cluster">
        <div className="brand-chip">B</div>
        <div className="brand-copy">
          <span className="eyebrow">Gym Motion Bluetooth</span>
          <h1>Polar Tracking Dashboard</h1>
          <p>Real device telemetry and node management with no mock state.</p>
        </div>
      </div>

      <nav aria-label="Primary" className="route-nav">
        {routes.map((item) => (
          <button
            className="route-tab"
            data-active={route === item.id}
            key={item.id}
            onClick={() => onRouteChange(item.id)}
            type="button"
          >
            <span>{item.label}</span>
            {item.badge ? <span className="route-badge">{item.badge}</span> : null}
          </button>
        ))}
      </nav>

      <div className="header-controls">
        <div className="metric-ribbon">
          {metrics.map((metric) => (
            <article className="ribbon-metric" data-tone={metric.tone} key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </article>
          ))}
        </div>

        <div className="header-action-cluster">
          <div className="theme-indicator">
            <span className="eyebrow">Theme</span>
            <strong>{theme.preference}</strong>
          </div>

          <button className="command-button" onClick={onOpenCommandPalette} type="button">
            Command Menu
            <span>Ctrl K</span>
          </button>
        </div>
      </div>
    </header>
  );
}
