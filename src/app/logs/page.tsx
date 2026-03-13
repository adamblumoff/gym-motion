import { LiveStreamProvider } from "@/components/live-stream-provider";
import { DeviceLogsDashboard } from "@/components/device-logs-dashboard";
import { getInitialDeviceActivity, getInitialDevices } from "@/lib/server-data";

type LogsPageProps = {
  searchParams?: Promise<{
    deviceId?: string;
  }>;
};

export default async function LogsPage({ searchParams }: LogsPageProps) {
  const params = (await searchParams) ?? {};
  const devices = await getInitialDevices();
  const selectedDeviceId = params.deviceId ?? devices[0]?.id ?? null;
  const activities = await getInitialDeviceActivity(selectedDeviceId);

  return (
    <LiveStreamProvider>
      <main>
        <DeviceLogsDashboard
          initialDevices={devices}
          initialActivities={activities}
          initialSelectedDeviceId={selectedDeviceId}
        />
      </main>
    </LiveStreamProvider>
  );
}
