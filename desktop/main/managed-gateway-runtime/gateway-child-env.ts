import type { ApprovedNodeRule } from "@core/contracts";

export function buildGatewayChildEnv(args: {
  processEnv: NodeJS.ProcessEnv;
  runtimePort: number;
  approvedNodes: ApprovedNodeRule[];
}) {
  return {
    ...args.processEnv,
    GATEWAY_RUNTIME_HOST: "127.0.0.1",
    GATEWAY_RUNTIME_PORT: String(args.runtimePort),
    GATEWAY_APPROVED_NODE_RULES: JSON.stringify(args.approvedNodes),
  };
}
