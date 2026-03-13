import { LiveStreamProvider } from "@/components/live-stream-provider";
import { DeviceLogsDashboard } from "@/components/device-logs-dashboard";
import { GATEWAY_LOG_DEVICE_ID } from "@/lib/motion";
import { getInitialDeviceLogs, getInitialDevices } from "@/lib/server-data";

type LogsPageProps = {
  searchParams?: Promise<{
    deviceId?: string;
  }>;
};

export default async function LogsPage({ searchParams }: LogsPageProps) {
  const params = (await searchParams) ?? {};
  const requestedDeviceId = params.deviceId ?? GATEWAY_LOG_DEVICE_ID;
  const [devices, requestedLogs] = await Promise.all([
    getInitialDevices(),
    getInitialDeviceLogs(requestedDeviceId),
  ]);
  const selectedDeviceId = requestedDeviceId;
  const logs = requestedLogs;

  return (
    <LiveStreamProvider>
      <main>
        <DeviceLogsDashboard
          initialDevices={devices}
          initialLogs={logs}
          initialSelectedDeviceId={selectedDeviceId}
        />
      </main>
    </LiveStreamProvider>
  );
}
