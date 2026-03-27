import { describe, expect, it, vi } from "vitest";

import { createRouteModuleLoader } from "./route-modules";

describe("createRouteModuleLoader", () => {
  it("retries after a failed import and caches the successful module", async () => {
    const expectedModule = { value: "loaded" };
    const loadModule = vi
      .fn<() => Promise<typeof expectedModule>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValue(expectedModule);
    const loader = createRouteModuleLoader(loadModule);

    await expect(loader()).rejects.toThrow("chunk failed");
    await expect(loader()).resolves.toBe(expectedModule);
    await expect(loader.preload()).resolves.toBe(expectedModule);
    expect(loadModule).toHaveBeenCalledTimes(2);
  });
});
