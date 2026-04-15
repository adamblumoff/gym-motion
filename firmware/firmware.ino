#include <Wire.h>
#include <bluefruit.h>
#include <InternalFileSystem.h>
#include <nrf.h>

#include "runtime_host_protocol.hpp"
#include "persisted_state.hpp"

using namespace Adafruit_LittleFS_Namespace;

#define SPIFFS InternalFS
#define FILE_READ FILE_O_READ
#define FILE_WRITE FILE_O_WRITE
#define FILE_APPEND FILE_O_WRITE

const char* FIRMWARE_VERSION = "0.6.0-xiao.1";
#define GM_STRINGIFY_INNER(value) #value
#define GM_STRINGIFY(value) GM_STRINGIFY_INNER(value)
#ifndef GM_BUILD_TAG
#define GM_BUILD_TAG dev
#endif
const int PROVISION_RESET_PIN = 0;
const char* PREFS_FILE_PATH = "/prefs.json";
const char* PREFS_TEMP_FILE_PATH = "/prefs.tmp";
const char* PREFS_BACKUP_FILE_PATH = "/prefs.bak";
const char* PREF_DEVICE_ID = "device_id";
const char* PREF_SITE_ID = "site_id";
const char* PREF_MACHINE_LABEL = "machine_label";
const char* PREF_NEXT_SEQUENCE = "next_seq";
const char* PREF_ACKED_SEQUENCE = "acked_seq";
const char* PREF_HISTORY_OVERFLOW = "hist_ovf";
const char* PREF_HISTORY_DROPPED = "hist_drop";

const char* PROVISIONING_SERVICE_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c201";
const char* PROVISIONING_CONTROL_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c202";
const char* PROVISIONING_STATUS_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c203";

const char* RUNTIME_SERVICE_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7001";
const char* RUNTIME_TELEMETRY_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7002";
const char* RUNTIME_CONTROL_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7003";
const char* RUNTIME_STATUS_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7004";
const char* RUNTIME_OTA_DATA_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7005";
const char* HISTORY_SERVICE_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7101";
const char* HISTORY_CONTROL_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7102";
const char* HISTORY_STATUS_UUID = "4b2f41d1-6f1b-4d3a-92e5-7db4891f7103";

const uint8_t STHS34PF80_ADDR = 0x5A;
const uint8_t STHS34PF80_REG_WHO_AM_I = 0x0F;
const uint8_t STHS34PF80_REG_AVG_TRIM = 0x10;
const uint8_t STHS34PF80_REG_CTRL1 = 0x20;
const uint8_t STHS34PF80_REG_CTRL2 = 0x21;
const uint8_t STHS34PF80_REG_STATUS = 0x23;
const uint8_t STHS34PF80_REG_FUNC_STATUS = 0x25;
const uint8_t STHS34PF80_REG_TPRESENCE_L = 0x3A;
const uint8_t STHS34PF80_REG_TMOTION_L = 0x3C;
const uint8_t STHS34PF80_REG_FUNC_CFG_ADDR = 0x08;
const uint8_t STHS34PF80_REG_FUNC_CFG_DATA = 0x09;
const uint8_t STHS34PF80_REG_PAGE_RW = 0x11;
const uint8_t STHS34PF80_EMBEDDED_RESET_ALGO = 0x2A;
const uint8_t STHS34PF80_WHO_AM_I_VALUE = 0xD3;
const uint8_t STHS34PF80_DRDY_FLAG = 0x04;
const uint8_t STHS34PF80_PRES_FLAG = 0x04;
const uint8_t STHS34PF80_MOT_FLAG = 0x02;
const uint8_t STHS34PF80_ODR_POWER_DOWN = 0x00;
const uint8_t STHS34PF80_ODR_15_HZ = 0x07;

const unsigned long LOOP_DELAY_MS = 25;
const unsigned long KEEPALIVE_INTERVAL_MS = 1000;
// Give the IR sensor stream room for an occasional missed DRDY window before
// we surface "sensor_no_data" back to the desktop as a stale-reading warning.
const unsigned long SENSOR_SAMPLE_STALE_MS = 1500;
// Bench logs show the idle band sits roughly around 500-700 delta on this XIAO.
// Use a higher start threshold so we only enter moving on clear spikes above idle,
// while keeping a lower stop threshold for stable hysteresis back to still.
const int MOTION_DELTA_START_THRESHOLD = 1000;
const int MOTION_DELTA_STOP_THRESHOLD = 700;
const unsigned long MOTION_DELTA_STOP_HOLD_MS = 900;
const unsigned long OTA_DFU_HANDOFF_DELAY_MS = 750;
// The current desktop runtime talks to this node through the Windows WinRT
// sidecar handshake. Allow a little extra time for service discovery and the
// first bootstrap/control writes before we tear the client down as stale.
const unsigned long APP_SESSION_BOOTSTRAP_TIMEOUT_MS = 12000;
const unsigned long APP_SESSION_LEASE_DEFAULT_MS = 15000;
const unsigned long CONNECTED_RUNTIME_DEBUG_INTERVAL_MS = 5000;
const unsigned long DISCONNECTED_ADVERTISING_LOG_INTERVAL_MS = 10000;
const uint8_t RUNTIME_NOTIFY_MASK_STATUS = 0x01;
const uint8_t RUNTIME_NOTIFY_MASK_HISTORY = 0x02;
const uint8_t RUNTIME_NOTIFY_MASK_TELEMETRY = 0x04;
const unsigned long SENSOR_DEBUG_INTERVAL_MS = 500;
const unsigned long SENSOR_HISTORY_DEBUG_INTERVAL_MS = 2000;
const bool DIAGNOSTIC_BYPASS_FILESYSTEM_STARTUP = false;
const unsigned long PERSISTED_STATE_SAVE_DEBOUNCE_MS = 50;
const size_t HISTORY_MAX_BYTES = 48 * 1024;
const size_t HISTORY_RECLAIM_BYTES = 8 * 1024;
const size_t HISTORY_SYNC_PAGE_SIZE = 80;
const size_t STATUS_CHUNK_SIZE = 20;
const size_t BLE_TX_QUEUE_CAPACITY = 96;
const size_t BLE_TX_BURST_HISTORY_LIMIT = 1;
const unsigned long BLE_TX_MIN_INTERVAL_MS = 30;
const size_t HISTORY_WORKER_RECORDS_PER_SLICE = 4;
const char* HISTORY_LOG_PATH = "/history.log";
const char* HISTORY_TEMP_PATH = "/history.tmp";

bool haveLastReading = false;
unsigned long lastMotionTime = 0;
bool motionSensorReady = false;
const char* motionSensorIssue = "sensor_unavailable";
unsigned long lastFreshSensorSampleAt = 0;
int lastFreshSensorDelta = 0;
bool blePeripheralReady = false;

void ensureFilesystemReady();
void loadPersistedState();
void savePersistedState();
void flushPersistedStateIfNeeded();
String escapeJsonString(const String& value);
String extractJsonString(const String& json, const char* key);
unsigned long extractJsonUnsignedLong(
  const String& json,
  const char* key,
  unsigned long fallback
);
BLECharacteristic* provisioningControlCharacteristic = nullptr;
BLECharacteristic* provisioningStatusCharacteristic = nullptr;
BLECharacteristic* runtimeTelemetryCharacteristic = nullptr;
BLECharacteristic* runtimeControlCharacteristic = nullptr;
BLECharacteristic* runtimeStatusCharacteristic = nullptr;
BLECharacteristic* runtimeOtaDataCharacteristic = nullptr;
BLECharacteristic* historyControlCharacteristic = nullptr;
BLECharacteristic* historyStatusCharacteristic = nullptr;
String provisioningCommandBuffer;
String runtimeCommandBuffer;
String historyCommandBuffer;
bool provisioningCommandFramed = false;
bool runtimeCommandFramed = false;
bool historyCommandFramed = false;

String hardwareId;
String bootId;
String configuredDeviceId;
String configuredSiteId;
String configuredMachineLabel;

const char* currentDetectedState = "still";
const char* lastReportedState = "";
int lastReportedDelta = 0;
unsigned long lastTelemetryAt = 0;
bool provisioningBleConnected = false;
bool runtimeBleConnected = false;
bool runtimeAppSessionConnected = false;
bool runtimeBootstrapLeasePending = false;
bool runtimeBleConnIdKnown = false;
uint8_t runtimeNotifyMask = 0;
bool pendingMotionUpdate = false;
bool pendingOtaDfuRestart = false;
bool pendingHistorySyncRequest = false;
unsigned long pendingRebootAt = 0;
unsigned long runtimeConnectionEpoch = 0;
unsigned long runtimeDisconnectCount = 0;
unsigned long runtimeBleConnectedAt = 0;
unsigned long lastAppSessionLeaseAt = 0;
unsigned long lastDisconnectedAdvertisingLogAt = 0;
unsigned long lastConnectedRuntimeDebugAt = 0;
unsigned long lastMotionSensorDebugAt = 0;
unsigned long lastMotionSensorHistoryLogAt = 0;
unsigned long lastRuntimeControlAt = 0;
unsigned long runtimeControlWriteCount = 0;
unsigned long historyControlWriteCount = 0;
unsigned long appSessionLeaseTimeoutMs = APP_SESSION_LEASE_DEFAULT_MS;
unsigned long nextHistorySequence = 1;
unsigned long ackedHistorySequence = 0;
unsigned long lastJournaledSequence = 0;
unsigned long historyDroppedCount = 0;
bool historyOverflowed = false;
uint16_t runtimeBleConnId = 0;
String runtimeAppSessionId;
String runtimeAppSessionNonce;
firmware_runtime::HistoryControlCommand pendingHistorySyncCommand;
bool pendingHistoryControlDebugPublish = false;
String pendingHistoryControlDebugStage;
String pendingHistoryControlDebugRequestId;
unsigned long pendingHistoryControlDebugAfterSequence = 0;
String publishedHistoryControlDebugPayload;
bool runtimeHistoryChunkDirectNotified = false;
struct BleTxMessage {
  BLECharacteristic* characteristic = nullptr;
  bool* connectedFlag = nullptr;
  String payload;
};

struct BleTxQueue {
  BleTxMessage entries[BLE_TX_QUEUE_CAPACITY];
  size_t head = 0;
  size_t tail = 0;
  size_t length = 0;
};

enum class HistoryWorkerPhase {
  Idle,
  Streaming,
};

struct HistoryWorkerState {
  HistoryWorkerPhase phase = HistoryWorkerPhase::Idle;
  String sessionId;
  String requestId;
  unsigned long requestedAfterSequence = 0;
  size_t maxRecords = 0;
  unsigned long highWaterSequence = 0;
  unsigned long latestSequence = 0;
  size_t sentCount = 0;
  bool overflowed = false;
  unsigned long droppedCount = 0;
  bool pumpStartedLogged = false;
  bool firstRecordLogged = false;
};

BleTxQueue runtimeTxQueue;
BleTxQueue historyTxQueue;
HistoryWorkerState historyWorkerState;
File historyWorkerFile(SPIFFS);
unsigned long lastBleTxAt = 0;
String lastCompletedHistoryRequestId;
String lastAutoHistoryDecisionMessage;

struct OtaTransferState {
  bool active = false;
  size_t expectedBytes = 0;
  size_t receivedBytes = 0;
  String expectedSha256;
  String targetVersion;
};

OtaTransferState otaTransfer;

void initStatusLeds();
void setStatusLeds(bool redOn, bool greenOn, bool blueOn);
void markNodeBooting();
void markNodeAdvertising();
void markNodeConnected();
void markNodeBleFailure();

void sendRuntimeStatus(const String& phase, const String& message, const String& version = "");
void enqueueBoardLogStatus(
  const String& tag,
  const String& message,
  const String& level = "info"
);
void sendHistoryDebugStatus(
  const String& stage,
  const String& requestId,
  unsigned long afterSequence = 0,
  size_t sentCount = 0,
  const String& code = "",
  const String& message = ""
);
void notePendingHistoryControlDebug(
  const String& stage,
  const String& requestId,
  unsigned long afterSequence = 0
);
void publishPendingHistoryControlDebug();
void sendTelemetry(
  int delta,
  unsigned long timestamp,
  bool force = false,
  bool stateChanged = false
);
bool enqueueRuntimeNotification(BLECharacteristic* characteristic, const String& payload);
bool enqueueRuntimeNotificationChunked(BLECharacteristic* characteristic, const String& payload);
bool enqueueRuntimeStatusPayload(const String& payload);
bool enqueueHistoryNotification(BLECharacteristic* characteristic, const String& payload);
bool enqueueHistoryNotificationChunked(BLECharacteristic* characteristic, const String& payload);
bool enqueueHistoryStatusPayload(const String& payload);
void processBleNotificationQueues();
void maybeStartAutomaticHistorySync();
void processPendingHistorySyncRequest();
void pumpHistoryWorker();
void cancelHistoryWorker();
void scheduleHistorySyncRequest(const firmware_runtime::HistoryControlCommand& command);
void beginHistorySyncRequest(
  const firmware_runtime::HistoryControlCommand& command
);
void acknowledgeHistorySyncRequest(
  const firmware_runtime::HistoryControlCommand& command
);
bool sendHistoryError(
  const String& sessionId,
  const String& requestId,
  const String& code,
  const String& message
);

String escapeJsonString(const String& value) {
  String escaped;
  escaped.reserve(value.length() + 16);

  for (size_t index = 0; index < value.length(); index++) {
    const char character = value[index];

    switch (character) {
      case '\\':
        escaped += "\\\\";
        break;
      case '"':
        escaped += "\\\"";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        escaped += character;
        break;
    }
  }

  return escaped;
}

String extractJsonString(const String& json, const char* key) {
  const String token = "\"" + String(key) + "\":\"";
  const int start = json.indexOf(token);

  if (start < 0) {
    return "";
  }

  const int valueStart = start + token.length();
  int valueEnd = valueStart;

  while (valueEnd < json.length()) {
    if (json[valueEnd] == '"' && (valueEnd == valueStart || json[valueEnd - 1] != '\\')) {
      break;
    }

    valueEnd++;
  }

  String value = json.substring(valueStart, valueEnd);
  value.replace("\\/", "/");
  value.replace("\\\"", "\"");
  return value;
}

size_t extractJsonSize(const String& json, const char* key, size_t fallback = 0) {
  const String token = "\"" + String(key) + "\":";
  const int start = json.indexOf(token);

  if (start < 0) {
    return fallback;
  }

  int valueStart = start + token.length();
  while (valueStart < json.length() && json[valueStart] == ' ') {
    valueStart++;
  }

  int valueEnd = valueStart;
  while (valueEnd < json.length() && isDigit(json[valueEnd])) {
    valueEnd++;
  }

  if (valueEnd == valueStart) {
    return fallback;
  }

  return static_cast<size_t>(
    strtoull(json.substring(valueStart, valueEnd).c_str(), nullptr, 10)
  );
}

unsigned long extractJsonUnsignedLong(
  const String& json,
  const char* key,
  unsigned long fallback = 0
) {
  return static_cast<unsigned long>(extractJsonSize(json, key, fallback));
}

String createHardwareId() {
  char buffer[32];
  snprintf(
    buffer,
    sizeof(buffer),
    "nrf52-%08lx%08lx",
    static_cast<unsigned long>(NRF_FICR->DEVICEID[1]),
    static_cast<unsigned long>(NRF_FICR->DEVICEID[0])
  );
  return String(buffer);
}

String createBootId() {
  randomSeed(NRF_FICR->DEVICEID[0] ^ NRF_FICR->DEVICEID[1] ^ micros());
  const uint32_t randomValue = static_cast<uint32_t>(random(0x7fffffff));
  char buffer[48];
  snprintf(buffer, sizeof(buffer), "%s-%08lx", hardwareId.c_str(), randomValue);
  return String(buffer);
}

String activeDeviceId() {
  return configuredDeviceId.length() > 0 ? configuredDeviceId : hardwareId;
}

String createBleDeviceName() {
  const int suffixStart = hardwareId.length() > 6
    ? static_cast<int>(hardwareId.length() - 6)
    : 0;
  String name = "GymMotion-" + hardwareId.substring(suffixStart);
  if (runtimeAppSessionId.length() >= 8 && runtimeAppSessionNonce.length() > 0) {
    name += "-s" + runtimeAppSessionId.substring(0, 8);
  }
  return name;
}

String firmwareVersionString() {
  return String(FIRMWARE_VERSION) + "+" + String(GM_STRINGIFY(GM_BUILD_TAG));
}

void initStatusLeds() {
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_BLUE, OUTPUT);
  setStatusLeds(false, false, false);
}

void setStatusLeds(bool redOn, bool greenOn, bool blueOn) {
  digitalWrite(LED_RED, redOn ? LOW : HIGH);
  digitalWrite(LED_GREEN, greenOn ? LOW : HIGH);
  digitalWrite(LED_BLUE, blueOn ? LOW : HIGH);
}

void markNodeBooting() {
  setStatusLeds(true, false, false);
}

void markNodeAdvertising() {
  setStatusLeds(false, false, true);
}

void markNodeConnected() {
  setStatusLeds(false, true, false);
}

void markNodeBleFailure() {
  setStatusLeds(true, false, false);
}


void finalizePendingRollback(bool healthy) {
  (void)healthy;
}

void setup() {
  Serial.begin(115200);
  delay(250);
  Serial.println("[boot] setup start");
  initStatusLeds();
  markNodeBooting();

  pinMode(PROVISION_RESET_PIN, INPUT_PULLUP);
  hardwareId = createHardwareId();
  bootId = createBootId();
  Serial.println("[boot] identity");
  if (DIAGNOSTIC_BYPASS_FILESYSTEM_STARTUP) {
    Serial.println("[boot] filesystem mount only for diagnostics");
    ensureFilesystemReady();
    configuredDeviceId = "";
    configuredSiteId = "";
    configuredMachineLabel = "";
    nextHistorySequence = 1;
    ackedHistorySequence = 0;
    historyOverflowed = false;
    historyDroppedCount = 0;
  } else {
    Serial.println("[boot] filesystem");
    ensureFilesystemReady();
    loadPersistedState();
  }

  if (digitalRead(PROVISION_RESET_PIN) == LOW) {
    Serial.println("Provision reset button held. Clearing saved identity.");
    clearProvisioningConfig();
  }

  Wire.begin();
  Wire.setClock(400000);
  setupBle();
  finalizePendingRollback(true);
  Serial.print("Hardware ID: ");
  Serial.println(hardwareId);
  Serial.print("Boot ID: ");
  Serial.println(bootId);
  Serial.print("Device ID: ");
  Serial.println(activeDeviceId());
  Serial.print("Firmware version: ");
  Serial.println(firmwareVersionString());
  Serial.println("BLE motion runtime ready.");
}

void loop() {
  finishPendingRestart();
  enforceRuntimeAppSessionLease();
  processBleNotificationQueues();
  logConnectedRuntimeHeartbeat();
  logDisconnectedAdvertisingHeartbeat();
  updateMotionState();
  processBleNotificationQueues();
  delay(LOOP_DELAY_MS);
}
