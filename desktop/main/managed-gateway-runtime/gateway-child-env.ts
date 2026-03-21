import type { ApprovedNodeRule } from "@core/contracts";

export function buildGatewayChildEnv(args: {
  processEnv: NodeJS.ProcessEnv;
  runtimePort: number;
  approvedNodes: ApprovedNodeRule[];
  childOutboxPath: string;
  desktopApiBaseUrl: string;
}) {
  return {
    ...args.processEnv,
    GATEWAY_RUNTIME_HOST: "127.0.0.1",
    GATEWAY_RUNTIME_PORT: String(args.runtimePort),
    GATEWAY_APPROVED_NODE_RULES: JSON.stringify(args.approvedNodes),
    GATEWAY_CHILD_OUTBOX_PATH: args.childOutboxPath,
    GATEWAY_DESKTOP_API_BASE_URL: args.desktopApiBaseUrl,
  };
}
