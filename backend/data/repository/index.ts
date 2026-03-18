export {
  recordMotionEvent,
  recordHeartbeat,
  listDevices,
  listRecentEvents,
  listDeviceMotionEvents,
  findLatestDeviceMotionEventBefore,
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
