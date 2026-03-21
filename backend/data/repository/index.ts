export {
  recordMotionEvent,
  recordHeartbeat,
  listDevices,
  listRecentEvents,
  listDeviceRecentEvents,
  listDeviceMotionEvents,
  listDeviceMotionEventsByReceivedAt,
  findLatestDeviceMotionEventBefore,
  findLatestDeviceMotionEventBeforeReceivedAt,
  recordDeviceLog,
  listDeviceLogs,
  listDeviceActivity,
  listRecentActivity,
  getDeviceSyncState,
  getFirmwareHistorySyncState,
  recordBackfillBatch,
  hasMotionRollupTables,
  listMotionRollupBuckets,
  rebuildMotionRollups,
  refreshMotionRollupsForDeviceRange,
} from "./telemetry";

export {
  createOrUpdateDeviceRegistration,
  getDevice,
  updateDeviceAssignment,
  purgeDeviceData,
} from "./devices";

export {
  createFirmwareRelease,
  listFirmwareReleases,
  checkForFirmwareUpdate,
  recordFirmwareReport,
} from "./firmware";
