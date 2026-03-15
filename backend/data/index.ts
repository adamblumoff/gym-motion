export {
  formatZodError,
  parseBackfillBatch,
  parseDeviceAssignment,
  parseDeviceLog,
  parseDeviceRegistration,
  parseFirmwareReport,
  parseHeartbeatPayload,
  parseIngestPayload,
} from "../../legacy/src/lib/motion";

export {
  checkForFirmwareUpdate,
  createOrUpdateDeviceRegistration,
  getDeviceSyncState,
  listDeviceActivity,
  listDeviceLogs,
  listDevices,
  listRecentEvents,
  purgeDeviceData,
  recordBackfillBatch,
  recordDeviceLog,
  recordFirmwareReport,
  recordHeartbeat,
  recordMotionEvent,
  updateDeviceAssignment,
} from "../../legacy/src/lib/repository";
