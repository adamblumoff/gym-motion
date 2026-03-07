import { cache } from "react";

import {
  listDeviceLogs,
  listDevices,
  listRecentEvents,
} from "@/lib/repository";

export const getInitialDevices = cache(async () => listDevices());

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
