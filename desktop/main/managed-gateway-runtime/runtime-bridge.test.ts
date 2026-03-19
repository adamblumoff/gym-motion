import { describe, expect, it } from "vitest";

import { buildGatewayChildEnv } from "./gateway-child-env";

describe("buildGatewayChildEnv", () => {
  it("passes runtime configuration without desktop loopback metadata wiring", () => {
    const env = buildGatewayChildEnv({
      processEnv: {},
      runtimePort: 4510,
      approvedNodes: [
        {
          id: "known:esp32-001",
          label: "Leg Press",
          knownDeviceId: "esp32-001",
          peripheralId: "AA:BB",
          address: "AA:BB",
          localName: "GymMotion-aabb",
        },
      ],
    });

    const nextEnv = buildGatewayChildEnv({
      processEnv: {},
      runtimePort: 4511,
      approvedNodes: [],
    });

    expect(env.API_URL).toBeUndefined();
    expect(env.GATEWAY_RUNTIME_PORT).toBe("4510");
    expect(env.GATEWAY_APPROVED_NODE_RULES).toContain("esp32-001");
    expect(nextEnv.GATEWAY_RUNTIME_PORT).toBe("4511");
    expect(nextEnv.GATEWAY_APPROVED_NODE_RULES).toBe("[]");
  });
});
