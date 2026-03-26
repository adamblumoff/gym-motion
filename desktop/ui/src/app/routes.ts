import { createHashRouter } from "react-router";
import { AppLayout } from "./components/AppLayout";
import { Dashboard } from "./components/Dashboard";
import { SetupPage } from "./components/SetupPage";
import { AnalyticsPage } from "./components/AnalyticsPage";

export const router = createHashRouter([
  {
    Component: AppLayout,
    children: [
      {
        index: true,
        Component: Dashboard,
      },
      {
        path: "/setup",
        Component: SetupPage,
      },
      {
        path: "/analytics",
        Component: AnalyticsPage,
      },
    ],
  },
]);
