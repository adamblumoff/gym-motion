export {
  recordMotionEvent,
  recordHeartbeat,
  listDevices,
  listRecentEvents,
  listDeviceMotionEvents,
  listDeviceMotionEventsByReceivedAt,
  findLatestDeviceMotionEventBefore,
  findLatestDeviceMotionEventBeforeReceivedAt,
  recordDeviceLog,
  listDeviceLogs,
  listDeviceActivity,
  listRecentActivity,
  getDeviceSyncState,
  recordBackfillBatch,
  hasMotionRollupTables,
  listMotionRollupBuckets,
  rebuildMotionRollups,
  refreshMotionRollupsForDeviceRange,
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
