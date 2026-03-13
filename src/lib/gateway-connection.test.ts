import { describe, expect, it } from "bun:test";

import {
  buildGatewayUrl,
  normalizeGatewayBaseUrl,
} from "@/lib/gateway-connection";

describe("gateway connection helpers", () => {
  it("normalizes bare hostnames to http origins", () => {
    expect(normalizeGatewayBaseUrl("gateway.local:3000")).toBe(
      "http://gateway.local:3000",
    );
  });

  it("strips paths and trailing slashes", () => {
    expect(normalizeGatewayBaseUrl("https://gateway.local:3000/setup/")).toBe(
      "https://gateway.local:3000",
    );
  });

  it("builds absolute gateway API URLs when a gateway is selected", () => {
    expect(buildGatewayUrl("http://gateway.local:3000", "/api/devices")).toBe(
      "http://gateway.local:3000/api/devices",
    );
  });

  it("keeps relative paths when no gateway is selected", () => {
    expect(buildGatewayUrl(null, "/api/devices")).toBe("/api/devices");
  });
});
