#include <Wire.h>
#include <bluefruit.h>
#include <InternalFileSystem.h>
#include <nrf.h>

#include "runtime_host_protocol.hpp"

using namespace Adafruit_LittleFS_Namespace;

#define SPIFFS InternalFS
#define FILE_READ FILE_O_READ
#define FILE_WRITE FILE_O_WRITE
#define FILE_APPEND FILE_O_WRITE

const char* FIRMWARE_VERSION = "0.6.0-xiao.1";
const int PROVISION_RESET_PIN = 0;
const char* PREFS_FILE_PATH = "/prefs.json";
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
const uint8_t STHS34PF80_REG_FUNC_STATUS = 0x25;
const uint8_t STHS34PF80_REG_TPRESENCE_L = 0x3A;
const uint8_t STHS34PF80_REG_TMOTION_L = 0x3C;
const uint8_t STHS34PF80_REG_FUNC_CFG_ADDR = 0x08;
const uint8_t STHS34PF80_REG_FUNC_CFG_DATA = 0x09;
const uint8_t STHS34PF80_REG_PAGE_RW = 0x11;
const uint8_t STHS34PF80_EMBEDDED_RESET_ALGO = 0x2A;
const uint8_t STHS34PF80_WHO_AM_I_VALUE = 0xD3;
const uint8_t STHS34PF80_PRES_FLAG = 0x04;
const uint8_t STHS34PF80_MOT_FLAG = 0x02;

const unsigned long STOP_TIMEOUT_MS = 600;
const unsigned long LOOP_DELAY_MS = 25;
const unsigned long KEEPALIVE_INTERVAL_MS = 15000;
// The current desktop runtime talks to this node through the Windows WinRT
// sidecar handshake. Allow a little extra time for service discovery and the
// first bootstrap/control writes before we tear the client down as stale.
const unsigned long APP_SESSION_BOOTSTRAP_TIMEOUT_MS = 12000;
const unsigned long APP_SESSION_LEASE_DEFAULT_MS = 15000;
const unsigned long CONNECTED_RUNTIME_DEBUG_INTERVAL_MS = 5000;
const unsigned long DISCONNECTED_ADVERTISING_LOG_INTERVAL_MS = 10000;
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
bool blePeripheralReady = false;

void ensureFilesystemReady();
void loadPersistedState();
void savePersistedState();
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
bool runtimeLeaseRequired = false;
bool runtimeBleConnIdKnown = false;
bool pendingMotionUpdate = false;
unsigned long pendingRebootAt = 0;
unsigned long runtimeBleConnectedAt = 0;
unsigned long lastAppSessionLeaseAt = 0;
unsigned long lastDisconnectedAdvertisingLogAt = 0;
unsigned long lastConnectedRuntimeDebugAt = 0;
unsigned long lastRuntimeControlAt = 0;
unsigned long appSessionLeaseTimeoutMs = APP_SESSION_LEASE_DEFAULT_MS;
unsigned long nextHistorySequence = 1;
unsigned long ackedHistorySequence = 0;
unsigned long lastJournaledSequence = 0;
unsigned long historyDroppedCount = 0;
bool historyOverflowed = false;
uint16_t runtimeBleConnId = 0;
String runtimeAppSessionId;
String runtimeAppSessionNonce;
String runtimeBootstrapSessionNonce;

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
  AwaitingAck,
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
  bool completionQueued = false;
  bool completionDelivered = false;
};

BleTxQueue runtimeTxQueue;
BleTxQueue historyTxQueue;
HistoryWorkerState historyWorkerState;
File historyWorkerFile(SPIFFS);
unsigned long lastBleTxAt = 0;
String lastCompletedHistoryRequestId;

struct OtaTransferState {
  bool active = false;
  size_t expectedBytes = 0;
  size_t receivedBytes = 0;
  String expectedSha256;
  String targetVersion;
};

OtaTransferState otaTransfer;

void sendRuntimeStatus(const String& phase, const String& message, const String& version = "");
void sendTelemetry(
  int delta,
  unsigned long timestamp,
  bool force = false,
  bool stateChanged = false
);
void enqueueRuntimeNotification(BLECharacteristic* characteristic, const String& payload);
void enqueueRuntimeNotificationChunked(BLECharacteristic* characteristic, const String& payload);
void enqueueHistoryNotification(BLECharacteristic* characteristic, const String& payload);
void enqueueHistoryNotificationChunked(BLECharacteristic* characteristic, const String& payload);
void processBleNotificationQueues();
void pumpHistoryWorker();
void cancelHistoryWorker();
void beginHistorySyncRequest(
  const firmware_runtime::HistoryControlCommand& command
);
void acknowledgeHistorySyncRequest(
  const firmware_runtime::HistoryControlCommand& command
);
void sendHistoryError(
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
  return "GymMotion-" + hardwareId.substring(suffixStart);
}


void finalizePendingRollback(bool healthy) {
  (void)healthy;
}

void setup() {
  Serial.begin(115200);
  delay(250);

  pinMode(PROVISION_RESET_PIN, INPUT_PULLUP);
  ensureFilesystemReady();
  hardwareId = createHardwareId();
  bootId = createBootId();
  loadPersistedState();

  if (digitalRead(PROVISION_RESET_PIN) == LOW) {
    Serial.println("Provision reset button held. Clearing saved identity.");
    clearProvisioningConfig();
  }

  Wire.begin();
  Wire.setClock(400000);
  setupMotionSensor();
  setupBle();
  finalizePendingRollback(true);
  journalNodeLog("info", "device.boot", "BLE node booted.", millis());
  journalMotionState(currentDetectedState, 0, millis());

  Serial.print("Hardware ID: ");
  Serial.println(hardwareId);
  Serial.print("Boot ID: ");
  Serial.println(bootId);
  Serial.print("Device ID: ");
  Serial.println(activeDeviceId());
  Serial.print("Firmware version: ");
  Serial.println(FIRMWARE_VERSION);
  Serial.println("BLE motion runtime ready.");
}

void loop() {
  finishPendingRestart();
  enforceRuntimeAppSessionLease();
  pumpHistoryWorker();
  processBleNotificationQueues();
  logConnectedRuntimeHeartbeat();
  logDisconnectedAdvertisingHeartbeat();
  updateMotionState();
  processBleNotificationQueues();
  delay(LOOP_DELAY_MS);
}
