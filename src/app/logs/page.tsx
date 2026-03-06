import { Suspense } from "react";

import { DeviceLogsDashboard } from "@/components/device-logs-dashboard";

export default function LogsPage() {
  return (
    <main>
      <Suspense>
        <DeviceLogsDashboard />
      </Suspense>
    </main>
  );
}
