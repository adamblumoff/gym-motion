import { LiveStreamProvider } from "@/components/live-stream-provider";
import { SetupDashboard } from "@/components/setup-dashboard";
import { getInitialDevices } from "@/lib/server-data";

export default async function SetupPage() {
  const devices = await getInitialDevices();

  return (
    <LiveStreamProvider>
      <main>
        <SetupDashboard initialDevices={devices} />
      </main>
    </LiveStreamProvider>
  );
}
