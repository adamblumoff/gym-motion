// @ts-nocheck
import { METADATA_REFRESH_MS } from "./utils.js";

export function createMetadataManager({ loadDevicesMetadata, metadataByDeviceId, debug }) {
  let metadataLoadedAt = 0;

  async function refreshMetadata(force = false) {
    if (!force && Date.now() - metadataLoadedAt < METADATA_REFRESH_MS) {
      return;
    }

    try {
      const devices = await loadDevicesMetadata();

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
