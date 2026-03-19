// @ts-nocheck
import { METADATA_REFRESH_MS } from "./utils.js";

export function createMetadataManager({ apiBaseUrl, metadataByDeviceId, debug }) {
  let metadataLoadedAt = 0;

  async function refreshMetadata(force = false) {
    if (!force && Date.now() - metadataLoadedAt < METADATA_REFRESH_MS) {
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/devices`, {
        headers: {
          "Cache-Control": "no-store",
        },
      });

      if (!response.ok) {
        throw new Error(`/api/devices -> ${response.status}`);
      }

      const payload = await response.json();
      const devices = Array.isArray(payload?.devices) ? payload.devices : [];

      metadataByDeviceId.clear();

      for (const device of devices) {
        if (device?.id) {
          metadataByDeviceId.set(device.id, device);
        }
      }

      metadataLoadedAt = Date.now();
    } catch (error) {
      debug("metadata refresh failed", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    refreshMetadata,
  };
}
