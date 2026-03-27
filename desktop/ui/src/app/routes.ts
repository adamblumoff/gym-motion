import { createHashRouter } from "react-router";

import { AppLayout } from "./components/AppLayout";
import {
  loadAnalyticsRoute,
  loadDashboardRoute,
  loadSetupRoute,
} from "./route-modules";

export const router = createHashRouter([
  {
    Component: AppLayout,
    children: [
      {
        index: true,
        lazy: async () => {
          const module = await loadDashboardRoute();
          return { Component: module.Dashboard };
        },
      },
      {
        path: "/setup",
        lazy: async () => {
          const module = await loadSetupRoute();
          return { Component: module.SetupPage };
        },
      },
      {
        path: "/analytics",
        lazy: async () => {
          const module = await loadAnalyticsRoute();
          return { Component: module.AnalyticsPage };
        },
      },
    ],
  },
]);
