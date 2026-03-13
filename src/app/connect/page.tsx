import { GatewayConnectionPanel } from "@/components/gateway-connection-panel";
import { AppShell } from "@/components/app-shell";
import { LiveStreamProvider } from "@/components/live-stream-provider";

export default function ConnectPage() {
  return (
    <LiveStreamProvider>
      <AppShell
        description="This console automatically follows the Linux gateway host that served the page. The gateway is the only machine that talks to BLE sensor nodes."
        eyebrow="Gateway"
        title="Gateway status"
      >
        <GatewayConnectionPanel />
      </AppShell>
    </LiveStreamProvider>
  );
}
