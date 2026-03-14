import { LiveStreamProvider } from "@/components/live-stream-provider";
import { HomeShell } from "@/components/home-shell";
import { getInitialDevices, getInitialEvents } from "@/lib/server-data";

export default async function Home() {
  const [devices, events] = await Promise.all([
    getInitialDevices(),
    getInitialEvents(),
  ]);

  return (
    <LiveStreamProvider>
      <HomeShell initialDevices={devices} initialEvents={events} />
    </LiveStreamProvider>
  );
}
