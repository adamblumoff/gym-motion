import { createHashRouter } from "react-router";
import { Dashboard } from "./components/Dashboard";
import { SetupPage } from "./components/SetupPage";
import { AnalyticsPage } from "./components/AnalyticsPage";

export const router = createHashRouter([
  {
    path: "/",
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
]);
