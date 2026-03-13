import { GatewayConnectionPanel } from "@/components/gateway-connection-panel";
import { AppShell } from "@/components/app-shell";

export default function ConnectPage() {
  return (
    <AppShell
      description="Connect this operator console to the gateway on your local Wi-Fi network. The gateway is the only machine that talks to BLE sensor nodes."
      eyebrow="Gateway"
      title="Find your gateway"
    >
      <GatewayConnectionPanel />
    </AppShell>
  );
}
