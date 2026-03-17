import { describe, expect, it } from "bun:test";

import { buildGatewayChildEnv } from "./gateway-child-env";

describe("buildGatewayChildEnv", () => {
  it("reads the current desktop api url at child start time", () => {
    let currentApiBaseUrl = "http://127.0.0.1:0";

    const env = buildGatewayChildEnv({
      processEnv: {},
      getApiBaseUrl: () => currentApiBaseUrl,
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

    expect(env.API_URL).toBe("http://127.0.0.1:0");

    currentApiBaseUrl = "http://127.0.0.1:48123";

    const nextEnv = buildGatewayChildEnv({
      processEnv: {},
      getApiBaseUrl: () => currentApiBaseUrl,
      runtimePort: 4511,
      approvedNodes: [],
    });

    expect(nextEnv.API_URL).toBe("http://127.0.0.1:48123");
    expect(nextEnv.GATEWAY_RUNTIME_PORT).toBe("4511");
    expect(nextEnv.GATEWAY_APPROVED_NODE_RULES).toBe("[]");
  });
});
