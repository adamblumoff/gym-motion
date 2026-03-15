import { useEffect } from "react";

import type { GatewayRuntimeDeviceSummary, ThemePreference } from "@core/contracts";

import type { AppRoute } from "../App";

export function CommandPalette({
  open,
  routes,
  visibleDevices,
  selectedTheme,
  themeOptions,
  onRouteChange,
  onOpenDevice,
  onThemeChange,
  onRefresh,
  onRestartGateway,
  onClose,
}: {
  open: boolean;
  routes: Array<{ id: AppRoute; label: string }>;
  visibleDevices: GatewayRuntimeDeviceSummary[];
  selectedTheme: ThemePreference;
  themeOptions: ThemePreference[];
  onRouteChange: (route: AppRoute) => void;
  onOpenDevice: (deviceId: string) => void;
  onThemeChange: (theme: ThemePreference) => void;
  onRefresh: () => void;
  onRestartGateway: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          onClose();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <section
        aria-modal="true"
        className="command-palette"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Command Palette</span>
            <h3>Navigate and run real runtime actions</h3>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div className="command-grid">
          <article className="command-section">
            <span className="eyebrow">Routes</span>
            {routes.map((route) => (
              <button
                className="command-item"
                key={route.id}
                onClick={() => onRouteChange(route.id)}
                type="button"
              >
                {route.label}
              </button>
            ))}
          </article>

          <article className="command-section">
            <span className="eyebrow">Runtime</span>
            <button className="command-item" onClick={onRefresh} type="button">
              Scan nodes
            </button>
            <button className="command-item" onClick={onRestartGateway} type="button">
              Restart gateway
            </button>
          </article>

          <article className="command-section">
            <span className="eyebrow">Theme</span>
            {themeOptions.map((option) => (
              <button
                className="command-item"
                data-active={option === selectedTheme}
                key={option}
                onClick={() => onThemeChange(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </article>

          <article className="command-section">
            <span className="eyebrow">Inspect Node</span>
            {visibleDevices.length === 0 ? (
              <p className="empty-copy">No live devices available.</p>
            ) : (
              visibleDevices.slice(0, 6).map((device) => (
                <button
                  className="command-item"
                  key={device.id}
                  onClick={() => onOpenDevice(device.id)}
                  type="button"
                >
                  {device.machineLabel ?? device.id}
                </button>
              ))
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
