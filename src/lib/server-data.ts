import { cache } from "react";

import { getGatewayRuntimeDevices, getGatewayRuntimeHealth } from "@/lib/gateway-runtime-client";
import {
  listDeviceLogs,
  listRecentEvents,
} from "@/lib/repository";

export const getInitialGatewayHealth = cache(async () => getGatewayRuntimeHealth());

export const getInitialDevices = cache(async () => {
  const payload = await getGatewayRuntimeDevices();
  return payload.devices;
});

export const getInitialEvents = cache(async () => listRecentEvents());

export const getInitialDeviceLogs = cache(async (deviceId: string | null) => {
  if (!deviceId) {
    return [];
  }

  return listDeviceLogs({
    deviceId,
    limit: 100,
  });
});
