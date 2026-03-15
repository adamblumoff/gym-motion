export {
  recordMotionEvent,
  recordHeartbeat,
  listDevices,
  listRecentEvents,
  recordDeviceLog,
  listDeviceLogs,
  listDeviceActivity,
  getDeviceSyncState,
  recordBackfillBatch,
} from "./telemetry";

export {
  createOrUpdateDeviceRegistration,
  updateDeviceAssignment,
  purgeDeviceData,
} from "./devices";

export {
  createFirmwareRelease,
  listFirmwareReleases,
  checkForFirmwareUpdate,
  recordFirmwareReport,
} from "./firmware";
