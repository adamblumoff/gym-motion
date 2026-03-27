type RouteModuleLoader<TModule> = (() => Promise<TModule>) & {
  preload: () => Promise<TModule>;
};

function createRouteModuleLoader<TModule>(
  loadModule: () => Promise<TModule>,
): RouteModuleLoader<TModule> {
  let pending: Promise<TModule> | null = null;

  const load = (() => {
    pending ??= loadModule();
    return pending;
  }) as RouteModuleLoader<TModule>;

  load.preload = load;

  return load;
}

export const loadDashboardRoute = createRouteModuleLoader(
  () => import("./components/Dashboard"),
);
export const loadSetupRoute = createRouteModuleLoader(
  () => import("./components/SetupPage"),
);
export const loadAnalyticsRoute = createRouteModuleLoader(
  () => import("./components/AnalyticsPage"),
);

export function preloadRouteForPath(pathname: string) {
  switch (pathname) {
    case "/":
      return loadDashboardRoute.preload();
    case "/setup":
      return loadSetupRoute.preload();
    case "/analytics":
      return loadAnalyticsRoute.preload();
    default:
      return Promise.resolve(null);
  }
}

export function preloadSecondaryRoutes() {
  return Promise.all([
    loadSetupRoute.preload(),
    loadAnalyticsRoute.preload(),
  ]);
}
