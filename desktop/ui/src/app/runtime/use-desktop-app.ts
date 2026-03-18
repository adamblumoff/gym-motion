import { startTransition, useEffect, useState } from "react";

import { applyThemeState } from "../../lib/theme";
import { createDesktopAppActions } from "./actions";
import {
  applyRuntimeEventToState,
  applySetupState,
  replaceSnapshot,
  replaceThemeState,
} from "./reducer";
import { createInitialDesktopAppState } from "./state";

export function useDesktopApp() {
  const [state, setState] = useState(createInitialDesktopAppState);
  const actions = createDesktopAppActions(setState);

  useEffect(() => {
    let mounted = true;

    void window.gymMotionDesktop.getThemeState().then((themeState) => {
      if (!mounted) {
        return;
      }

      applyThemeState(themeState);
      setState((current) => replaceThemeState(current, themeState));
    });

    void window.gymMotionDesktop.getSnapshot().then((snapshot) => {
      if (!mounted) {
        return;
      }

      setState((current) => replaceSnapshot(current, snapshot));
    });

    void window.gymMotionDesktop.getSetupState().then((setup) => {
      if (!mounted) {
        return;
      }

      setState((current) => applySetupState(current, setup));
    });

    const unsubscribeRuntime = window.gymMotionDesktop.subscribeRuntime((event) => {
      if (event.type === "setup-updated") {
        setState((current) => applySetupState(current, event.setup));
        return;
      }

      if (event.type === "gateway-updated" || event.type === "device-upserted") {
        setState((current) => applyRuntimeEventToState(current, event));
        return;
      }

      startTransition(() => {
        setState((current) => applyRuntimeEventToState(current, event));
      });
    });

    const unsubscribeTheme = window.gymMotionDesktop.subscribeTheme((themeState) => {
      applyThemeState(themeState);
      setState((current) => replaceThemeState(current, themeState));
    });

    return () => {
      mounted = false;
      unsubscribeRuntime();
      unsubscribeTheme();
    };
  }, []);

  return {
    snapshot: state.snapshot,
    setup: state.setup,
    analyticsByKey: state.analyticsByKey,
    theme: state.theme,
    ...actions,
  };
}
