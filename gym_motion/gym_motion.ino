#include <Wire.h>
#include <SPIFFS.h>
#include <Update.h>
#include <Preferences.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

const char* FIRMWARE_VERSION = "0.5.2";
const int PROVISION_RESET_PIN = 0;
const char* PREFS_NAMESPACE = "gym-motion";
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

const uint8_t ADXL345_ADDR = 0x53;
const int SDA_PIN = 21;
const int SCL_PIN = 22;

const int MOTION_THRESHOLD = 70;
const unsigned long STOP_TIMEOUT_MS = 600;
const unsigned long LOOP_DELAY_MS = 25;
const unsigned long KEEPALIVE_INTERVAL_MS = 15000;
const unsigned long APP_SESSION_BOOTSTRAP_TIMEOUT_MS = 8000;
const unsigned long APP_SESSION_LEASE_DEFAULT_MS = 15000;
const unsigned long CONNECTED_RUNTIME_DEBUG_INTERVAL_MS = 5000;
const unsigned long DISCONNECTED_ADVERTISING_LOG_INTERVAL_MS = 10000;
const unsigned long OTA_RESTART_DELAY_MS = 1200;
const size_t HISTORY_MAX_BYTES = 48 * 1024;
const size_t HISTORY_RECLAIM_BYTES = 8 * 1024;
const size_t HISTORY_SYNC_PAGE_SIZE = 80;
const size_t STATUS_CHUNK_SIZE = 120;
const char* HISTORY_LOG_PATH = "/history.log";
const char* HISTORY_TEMP_PATH = "/history.tmp";

int16_t lastX = 0;
int16_t lastY = 0;
int16_t lastZ = 0;
bool haveLastReading = false;
unsigned long lastMotionTime = 0;

Preferences preferences;
BLEServer* bleServer = nullptr;
BLECharacteristic* provisioningControlCharacteristic = nullptr;
BLECharacteristic* provisioningStatusCharacteristic = nullptr;
BLE2902* provisioningStatusDescriptor = nullptr;
BLECharacteristic* runtimeTelemetryCharacteristic = nullptr;
BLECharacteristic* runtimeControlCharacteristic = nullptr;
BLECharacteristic* runtimeStatusCharacteristic = nullptr;
BLECharacteristic* runtimeOtaDataCharacteristic = nullptr;
BLE2902* runtimeTelemetryDescriptor = nullptr;
String provisioningCommandBuffer;
String runtimeCommandBuffer;

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

struct OtaTransferState {
  bool active = false;
  size_t expectedBytes = 0;
  size_t receivedBytes = 0;
  String expectedSha256;
  String targetVersion;
  mbedtls_sha256_context shaContext;
};

OtaTransferState otaTransfer;

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

String bytesToHex(const uint8_t* bytes, size_t length) {
  String result;
  result.reserve(length * 2);

  for (size_t index = 0; index < length; index++) {
    if (bytes[index] < 16) {
      result += "0";
    }

    result += String(bytes[index], HEX);
  }

  result.toLowerCase();
  return result;
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
  const uint64_t chipId = ESP.getEfuseMac();
  char buffer[32];
  snprintf(
    buffer,
    sizeof(buffer),
    "esp32-%04x%08lx",
    static_cast<uint16_t>(chipId >> 32),
    static_cast<uint32_t>(chipId)
  );
  return String(buffer);
}

String createBootId() {
  const uint32_t randomValue = esp_random();
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

void loadProvisioningConfig() {
  configuredDeviceId = preferences.getString(PREF_DEVICE_ID, "");
  configuredSiteId = preferences.getString(PREF_SITE_ID, "");
  configuredMachineLabel = preferences.getString(PREF_MACHINE_LABEL, "");
}

void loadHistoryConfig() {
  nextHistorySequence = preferences.getULong(PREF_NEXT_SEQUENCE, 1);
  ackedHistorySequence = preferences.getULong(PREF_ACKED_SEQUENCE, 0);
  historyOverflowed = preferences.getBool(PREF_HISTORY_OVERFLOW, false);
  historyDroppedCount = preferences.getULong(PREF_HISTORY_DROPPED, 0);
}

void clearProvisioningConfig() {
  preferences.remove(PREF_DEVICE_ID);
  preferences.remove(PREF_SITE_ID);
  preferences.remove(PREF_MACHINE_LABEL);
  configuredDeviceId = "";
  configuredSiteId = "";
  configuredMachineLabel = "";
}

void saveProvisioningConfig(
  const String& nextDeviceId,
  const String& nextSiteId,
  const String& nextMachineLabel
) {
  preferences.putString(PREF_DEVICE_ID, nextDeviceId);
  preferences.putString(PREF_SITE_ID, nextSiteId);
  preferences.putString(PREF_MACHINE_LABEL, nextMachineLabel);
  configuredDeviceId = nextDeviceId;
  configuredSiteId = nextSiteId;
  configuredMachineLabel = nextMachineLabel;
}

unsigned long allocateHistorySequence() {
  const unsigned long sequence = nextHistorySequence++;
  preferences.putULong(PREF_NEXT_SEQUENCE, nextHistorySequence);
  lastJournaledSequence = sequence;
  return sequence;
}

void persistHistoryOverflowState() {
  preferences.putBool(PREF_HISTORY_OVERFLOW, historyOverflowed);
  preferences.putULong(PREF_HISTORY_DROPPED, historyDroppedCount);
}

void replaceHistoryFile(File& tempFile) {
  tempFile.close();
  SPIFFS.remove(HISTORY_LOG_PATH);
  SPIFFS.rename(HISTORY_TEMP_PATH, HISTORY_LOG_PATH);
}

void compactHistoryAboveSequence(unsigned long keepAfterSequence) {
  File source = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!source) {
    return;
  }

  SPIFFS.remove(HISTORY_TEMP_PATH);
  File target = SPIFFS.open(HISTORY_TEMP_PATH, FILE_WRITE);
  if (!target) {
    source.close();
    return;
  }

  while (source.available()) {
    String line = source.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const unsigned long sequence = extractJsonUnsignedLong(line, "sequence", 0);
    if (sequence <= keepAfterSequence) {
      continue;
    }

    target.println(line);
  }

  source.close();
  replaceHistoryFile(target);
}

void dropOldestHistoryRecords(size_t bytesToDrop) {
  File source = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!source) {
    return;
  }

  SPIFFS.remove(HISTORY_TEMP_PATH);
  File target = SPIFFS.open(HISTORY_TEMP_PATH, FILE_WRITE);
  if (!target) {
    source.close();
    return;
  }

  size_t droppedBytes = 0;
  unsigned long droppedRecords = 0;

  while (source.available()) {
    String line = source.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const size_t lineBytes = line.length() + 1;
    if (droppedBytes < bytesToDrop) {
      droppedBytes += lineBytes;
      droppedRecords++;
      continue;
    }

    target.println(line);
  }

  source.close();
  replaceHistoryFile(target);

  if (droppedRecords > 0) {
    historyOverflowed = true;
    historyDroppedCount += droppedRecords;
    persistHistoryOverflowState();
  }
}

void enforceHistoryStorageLimit() {
  File history = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!history) {
    return;
  }

  const size_t currentSize = history.size();
  history.close();

  if (currentSize <= HISTORY_MAX_BYTES) {
    return;
  }

  compactHistoryAboveSequence(ackedHistorySequence);

  history = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!history) {
    return;
  }

  const size_t compactedSize = history.size();
  history.close();

  if (compactedSize <= HISTORY_MAX_BYTES) {
    return;
  }

  const size_t bytesToDrop =
    (compactedSize - HISTORY_MAX_BYTES) + HISTORY_RECLAIM_BYTES;
  dropOldestHistoryRecords(bytesToDrop);
}

void appendHistoryRecord(const String& recordJson) {
  File history = SPIFFS.open(HISTORY_LOG_PATH, FILE_APPEND);
  if (!history) {
    return;
  }

  history.println(recordJson);
  history.close();
  enforceHistoryStorageLimit();
}

void journalNodeLog(
  const String& level,
  const String& code,
  const String& message,
  unsigned long timestamp
) {
  const unsigned long sequence = allocateHistorySequence();
  appendHistoryRecord(
    "{\"kind\":\"node-log\",\"sequence\":" + String(sequence) +
    ",\"level\":\"" + escapeJsonString(level) +
    "\",\"code\":\"" + escapeJsonString(code) +
    "\",\"message\":\"" + escapeJsonString(message) +
    "\",\"timestamp\":" + String(timestamp) +
    ",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}"
  );
}

void journalMotionState(const char* state, int delta, unsigned long timestamp) {
  const unsigned long sequence = allocateHistorySequence();
  appendHistoryRecord(
    "{\"kind\":\"motion\",\"sequence\":" + String(sequence) +
    ",\"state\":\"" + String(state) +
    "\",\"delta\":" + String(delta) +
    ",\"timestamp\":" + String(timestamp) +
    ",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}"
  );
}

void acknowledgeHistoryThrough(unsigned long sequence) {
  if (sequence <= ackedHistorySequence) {
    return;
  }

  ackedHistorySequence = sequence;
  preferences.putULong(PREF_ACKED_SEQUENCE, ackedHistorySequence);
  compactHistoryAboveSequence(ackedHistorySequence);

  if (historyOverflowed) {
    historyOverflowed = false;
    historyDroppedCount = 0;
    persistHistoryOverflowState();
  }
}

void sendHistorySyncComplete(
  unsigned long latestSequence,
  unsigned long highWaterSequence,
  size_t sentCount
) {
  String payload =
    "{\"type\":\"history-sync-complete\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"latestSequence\":" + String(latestSequence) +
    ",\"highWaterSequence\":" + String(highWaterSequence) +
    ",\"sentCount\":" + String(sentCount) +
    ",\"hasMore\":" + String(latestSequence < highWaterSequence ? "true" : "false");

  if (historyOverflowed) {
    payload += ",\"overflowed\":true,\"droppedCount\":" + String(historyDroppedCount);
  }

  payload += "}";
  notifyCharacteristicChunked(runtimeStatusCharacteristic, runtimeBleConnected, payload);
}

void streamHistoryRecords(unsigned long afterSequence, size_t maxRecords) {
  File history = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  const unsigned long highWaterSequence =
    nextHistorySequence > 0 ? nextHistorySequence - 1 : 0;

  if (!history) {
    sendHistorySyncComplete(afterSequence, highWaterSequence, 0);
    return;
  }

  size_t sentCount = 0;
  unsigned long latestSequence = afterSequence;

  while (history.available()) {
    String line = history.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const unsigned long sequence = extractJsonUnsignedLong(line, "sequence", 0);
    if (sequence <= afterSequence) {
      continue;
    }

    if (sentCount >= maxRecords) {
      break;
    }

    notifyCharacteristicChunked(
      runtimeStatusCharacteristic,
      runtimeBleConnected,
      "{\"type\":\"history-record\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
      "\",\"record\":" + line + "}"
    );
    latestSequence = sequence;
    sentCount++;
  }

  history.close();
  sendHistorySyncComplete(latestSequence, highWaterSequence, sentCount);
}

void writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(ADXL345_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

void readRegisters(uint8_t startReg, uint8_t* buffer, uint8_t len) {
  Wire.beginTransmission(ADXL345_ADDR);
  Wire.write(startReg);
  Wire.endTransmission(false);
  Wire.requestFrom(ADXL345_ADDR, len);

  uint8_t i = 0;
  while (Wire.available() && i < len) {
    buffer[i++] = Wire.read();
  }
}

void readAccel(int16_t& x, int16_t& y, int16_t& z) {
  uint8_t data[6];
  readRegisters(0x32, data, 6);

  x = static_cast<int16_t>((data[1] << 8) | data[0]);
  y = static_cast<int16_t>((data[3] << 8) | data[2]);
  z = static_cast<int16_t>((data[5] << 8) | data[4]);
}

void setupADXL345() {
  writeRegister(0x2D, 0x08);
  writeRegister(0x31, 0x08);
}

void notifyCharacteristic(BLECharacteristic* characteristic, bool connected, const String& payload) {
  if (characteristic == nullptr) {
    Serial.print("BLE notify skipped (missing characteristic): ");
    Serial.println(payload);
    return;
  }

  if (!connected) {
    Serial.print("BLE notify skipped (runtime client disconnected): ");
    Serial.println(payload);
    return;
  }

  Serial.print("BLE notify sent: ");
  Serial.println(payload);
  characteristic->setValue(payload.c_str());
  characteristic->notify();
  delay(30);
}

void notifyCharacteristicChunked(BLECharacteristic* characteristic, bool connected, const String& payload) {
  if (characteristic == nullptr) {
    Serial.print("BLE chunked notify skipped (missing characteristic): ");
    Serial.println(payload);
    return;
  }

  if (!connected) {
    Serial.print("BLE chunked notify skipped (runtime client disconnected): ");
    Serial.println(payload);
    return;
  }

  Serial.print("BLE chunked notify sent: ");
  Serial.println(payload);
  characteristic->setValue(("BEGIN:" + String(payload.length())).c_str());
  characteristic->notify();
  delay(30);

  for (size_t offset = 0; offset < payload.length(); offset += STATUS_CHUNK_SIZE) {
    const String chunk = payload.substring(offset, offset + STATUS_CHUNK_SIZE);
    characteristic->setValue(chunk.c_str());
    characteristic->notify();
    delay(30);
  }

  characteristic->setValue("END");
  characteristic->notify();
  delay(30);
}

void sendProvisioningStatus(const String& payload) {
  notifyCharacteristic(provisioningStatusCharacteristic, provisioningBleConnected, payload);
}

String createProvisioningReadyPayload() {
  return
    "{\"type\":\"ready\",\"hardwareId\":\"" + escapeJsonString(hardwareId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"deviceName\":\"" + escapeJsonString(createBleDeviceName()) + "\"}";
}

void sendProvisioningReady() {
  sendProvisioningStatus(createProvisioningReadyPayload());
}

void sendRuntimeStatus(const String& phase, const String& message, const String& version = "") {
  String payload = "{\"type\":\"ota-status\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"phase\":\"" + escapeJsonString(phase) +
    "\",\"message\":\"" + escapeJsonString(message) + "\"";

  if (version.length() > 0) {
    payload += ",\"version\":\"" + escapeJsonString(version) + "\"";
  }

  payload += "}";
  notifyCharacteristicChunked(runtimeStatusCharacteristic, runtimeBleConnected, payload);
}

void logRuntimeTransportEvent(const String& message) {
  Serial.print("[runtime] ");
  Serial.println(message);
}

void configureRuntimeAdvertisingPayload(BLEAdvertising* advertising) {
  if (advertising == nullptr) {
    return;
  }

  advertising->stop();
  advertising->reset();
  advertising->setScanResponse(true);

  BLEAdvertisementData advertisementData;
  advertisementData.setFlags(ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT);
  advertisementData.setName(createBleDeviceName());
  advertisementData.setCompleteServices(BLEUUID(PROVISIONING_SERVICE_UUID));
  advertising->setAdvertisementData(advertisementData);

  BLEAdvertisementData scanResponseData;
  scanResponseData.setPartialServices(BLEUUID(RUNTIME_SERVICE_UUID));
  advertising->setScanResponseData(scanResponseData);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
}

void startRuntimeAdvertising(const String& reason) {
  if (bleServer == nullptr) {
    return;
  }

  BLEAdvertising* advertising = bleServer->getAdvertising();

  if (advertising == nullptr) {
    return;
  }

  configureRuntimeAdvertisingPayload(advertising);
  advertising->start();
  lastDisconnectedAdvertisingLogAt = millis();
  logRuntimeTransportEvent(
    "Advertising for Windows app reconnect (" + reason + ") as " +
    createBleDeviceName() + " with runtime scan response."
  );
}

void logRuntimeLeaseState(const char* reason, unsigned long now) {
  Serial.print("[runtime] ");
  Serial.print(reason);
  Serial.print(" connected=");
  Serial.print(runtimeBleConnected ? 1 : 0);
  Serial.print(" leased=");
  Serial.print(runtimeAppSessionConnected ? 1 : 0);
  Serial.print(" connKnown=");
  Serial.print(runtimeBleConnIdKnown ? 1 : 0);
  Serial.print(" connId=");
  Serial.print(runtimeBleConnIdKnown ? runtimeBleConnId : 0);
  Serial.print(" msSinceConnect=");
  Serial.print(runtimeBleConnectedAt > 0 ? now - runtimeBleConnectedAt : 0);
  Serial.print(" msSinceLease=");
  Serial.print(lastAppSessionLeaseAt > 0 ? now - lastAppSessionLeaseAt : 0);
  Serial.print(" msSinceControl=");
  Serial.print(lastRuntimeControlAt > 0 ? now - lastRuntimeControlAt : 0);
  Serial.print(" leaseTimeoutMs=");
  Serial.print(appSessionLeaseTimeoutMs);
  Serial.print(" sessionId=");
  if (runtimeAppSessionId.length() > 0) {
    Serial.println(runtimeAppSessionId);
    return;
  }

  Serial.println("(none)");
}

void resetRuntimeAppSessionState() {
  runtimeAppSessionConnected = false;
  runtimeBootstrapLeasePending = false;
  runtimeLeaseRequired = false;
  runtimeAppSessionId = "";
  lastAppSessionLeaseAt = 0;
  lastRuntimeControlAt = 0;
  appSessionLeaseTimeoutMs = APP_SESSION_LEASE_DEFAULT_MS;
}

void armRuntimeBootstrapWatchdog(const String& message) {
  if (!runtimeBleConnected || runtimeLeaseRequired || runtimeBootstrapLeasePending) {
    return;
  }

  runtimeBootstrapLeasePending = true;
  logRuntimeTransportEvent(message);
}

void disarmRuntimeBootstrapWatchdog() {
  runtimeBootstrapLeasePending = false;
}

void markRuntimeAppSessionOnline(
  const String& sessionId,
  unsigned long expiresInMs,
  unsigned long timestamp
) {
  const unsigned long nextTimeout =
    expiresInMs > 0 ? expiresInMs : APP_SESSION_LEASE_DEFAULT_MS;
  const bool sessionChanged =
    !runtimeAppSessionConnected || runtimeAppSessionId != sessionId;

  runtimeAppSessionConnected = true;
  runtimeAppSessionId = sessionId;
  lastAppSessionLeaseAt = timestamp;
  lastRuntimeControlAt = timestamp;
  appSessionLeaseTimeoutMs = nextTimeout;

  if (!sessionChanged) {
    logRuntimeLeaseState("Lease refreshed.", timestamp);
    return;
  }

  logRuntimeTransportEvent(
    "Windows app session lease is active for session " + sessionId + "."
  );

  journalNodeLog(
    "info",
    "runtime.app_session.online",
    "Windows app session lease is active.",
    timestamp
  );
}

void noteRuntimeAppSessionExpired(unsigned long timestamp) {
  const bool hadSession = runtimeAppSessionConnected || runtimeAppSessionId.length() > 0;
  resetRuntimeAppSessionState();

  if (!hadSession) {
    return;
  }

  logRuntimeTransportEvent(
    "Windows app session lease expired; dropping BLE client and resuming advertising."
  );

  journalNodeLog(
    "warn",
    "runtime.app_session.expired",
    "Windows app session lease expired; resetting BLE advertising.",
    timestamp
  );
}

void noteRuntimeTransportDisconnected(unsigned long timestamp) {
  const bool hadSession = runtimeAppSessionConnected || runtimeAppSessionId.length() > 0;
  resetRuntimeAppSessionState();
  runtimeBleConnIdKnown = false;
  runtimeBleConnId = 0;

  logRuntimeTransportEvent(
    "BLE runtime transport disconnected from the Windows app."
  );

  if (!hadSession) {
    return;
  }

  journalNodeLog(
    "warn",
    "runtime.app_session.offline",
    "BLE runtime transport disconnected from the Windows app.",
    timestamp
  );
}

void enforceRuntimeAppSessionLease() {
  if (!runtimeBleConnected) {
    return;
  }

  const unsigned long now = millis();

  if (runtimeBootstrapLeasePending) {
    if (
      runtimeBleConnectedAt > 0 &&
      now - runtimeBleConnectedAt >= APP_SESSION_BOOTSTRAP_TIMEOUT_MS
    ) {
      logRuntimeLeaseState("Bootstrap lease timeout fired.", now);
      journalNodeLog(
        "warn",
        "runtime.app_session.missing",
        "BLE client connected without runtime control traffic; dropping stale client.",
        now
      );
      logRuntimeTransportEvent(
        "BLE client never started a runtime session; dropping stale client."
      );
      resetRuntimeAppSessionState();

      if (bleServer != nullptr && runtimeBleConnIdKnown) {
        bleServer->disconnect(runtimeBleConnId);
        return;
      }

      startRuntimeAdvertising("missing runtime bootstrap");
    }

    return;
  }

  if (!runtimeLeaseRequired) {
    return;
  }

  if (!runtimeAppSessionConnected || lastAppSessionLeaseAt == 0) {
    if (
      runtimeBleConnectedAt > 0 &&
      now - runtimeBleConnectedAt >= APP_SESSION_BOOTSTRAP_TIMEOUT_MS
    ) {
      logRuntimeLeaseState("Bootstrap lease timeout fired.", now);
      journalNodeLog(
        "warn",
        "runtime.app_session.missing",
        "BLE client connected without an app session lease; dropping stale client.",
        now
      );
      logRuntimeTransportEvent(
        "BLE client never leased the Windows app session; dropping stale client."
      );
      resetRuntimeAppSessionState();

      if (bleServer != nullptr && runtimeBleConnIdKnown) {
        bleServer->disconnect(runtimeBleConnId);
        return;
      }

      startRuntimeAdvertising("missing app-session lease");
    }

    return;
  }
  if (now - lastAppSessionLeaseAt < appSessionLeaseTimeoutMs) {
    return;
  }

  logRuntimeLeaseState("Lease expiry timeout fired.", now);
  noteRuntimeAppSessionExpired(now);

  if (bleServer != nullptr && runtimeBleConnIdKnown) {
    bleServer->disconnect(runtimeBleConnId);
    return;
  }

  startRuntimeAdvertising("expired app-session lease");
}

void sendTelemetry(int delta, unsigned long timestamp, bool force = false) {
  if (!runtimeBleConnected) {
    return;
  }

  if (!force &&
      strcmp(lastReportedState, currentDetectedState) == 0 &&
      timestamp - lastTelemetryAt < KEEPALIVE_INTERVAL_MS) {
    return;
  }

  const String payload =
    "{\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"state\":\"" + String(currentDetectedState) +
    "\",\"sequence\":" + String(lastJournaledSequence) +
    ",\"delta\":" + String(delta) +
    ",\"timestamp\":" + String(timestamp) +
    ",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}";

  notifyCharacteristic(runtimeTelemetryCharacteristic, runtimeBleConnected, payload);
  lastReportedState = currentDetectedState;
  lastReportedDelta = delta;
  lastTelemetryAt = timestamp;
  pendingMotionUpdate = false;
}

void finishPendingRestart() {
  if (pendingRebootAt == 0 || millis() < pendingRebootAt) {
    return;
  }

  delay(200);
  ESP.restart();
}

void abortOtaTransfer(const String& reason) {
  if (otaTransfer.active) {
    Update.abort();
    mbedtls_sha256_free(&otaTransfer.shaContext);
  }

  otaTransfer.active = false;
  otaTransfer.expectedBytes = 0;
  otaTransfer.receivedBytes = 0;
  otaTransfer.expectedSha256 = "";
  otaTransfer.targetVersion = "";
  sendRuntimeStatus("error", reason);
}

void beginOtaTransfer(const String& payload) {
  if (otaTransfer.active) {
    abortOtaTransfer("ota-begin-replaced-existing-session");
  }

  const size_t expectedBytes = extractJsonSize(payload, "size", 0);
  const String targetVersion = extractJsonString(payload, "version");
  const String expectedSha256 = extractJsonString(payload, "sha256");

  if (expectedBytes == 0 || targetVersion.length() == 0) {
    sendRuntimeStatus("error", "ota-begin-missing-metadata");
    return;
  }

  if (!Update.begin(expectedBytes)) {
    sendRuntimeStatus("error", "update-begin-failed");
    return;
  }

  otaTransfer.active = true;
  otaTransfer.expectedBytes = expectedBytes;
  otaTransfer.receivedBytes = 0;
  otaTransfer.expectedSha256 = expectedSha256;
  otaTransfer.targetVersion = targetVersion;
  mbedtls_sha256_init(&otaTransfer.shaContext);
  mbedtls_sha256_starts(&otaTransfer.shaContext, 0);

  sendRuntimeStatus("ready", "ota-ready", targetVersion);
}

void handleOtaDataWrite(const std::string& rawValue) {
  if (!otaTransfer.active) {
    return;
  }

  uint8_t* bytes = reinterpret_cast<uint8_t*>(const_cast<char*>(rawValue.data()));
  const size_t length = rawValue.length();

  if (length == 0) {
    return;
  }

  if (Update.write(bytes, length) != length) {
    abortOtaTransfer("update-write-failed");
    return;
  }

  mbedtls_sha256_update(&otaTransfer.shaContext, bytes, length);
  otaTransfer.receivedBytes += length;
}

void completeOtaTransfer() {
  if (!otaTransfer.active) {
    sendRuntimeStatus("error", "ota-end-without-session");
    return;
  }

  if (otaTransfer.receivedBytes != otaTransfer.expectedBytes) {
    abortOtaTransfer("ota-size-mismatch");
    return;
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&otaTransfer.shaContext, digest);
  mbedtls_sha256_free(&otaTransfer.shaContext);

  const String actualSha256 = bytesToHex(digest, sizeof(digest));
  if (otaTransfer.expectedSha256.length() > 0 && actualSha256 != otaTransfer.expectedSha256) {
    otaTransfer.active = false;
    Update.abort();
    sendRuntimeStatus("error", "ota-sha256-mismatch", otaTransfer.targetVersion);
    return;
  }

  if (!Update.end() || !Update.isFinished()) {
    otaTransfer.active = false;
    sendRuntimeStatus("error", "update-end-failed", otaTransfer.targetVersion);
    return;
  }

  otaTransfer.active = false;
  sendRuntimeStatus("applied", "ota-applied", otaTransfer.targetVersion);
  pendingRebootAt = millis() + OTA_RESTART_DELAY_MS;
}

void handleProvisioningCommand(const String& payload) {
  runtimeBootstrapLeasePending = false;
  const String type = extractJsonString(payload, "type");

  if (type != "provision") {
    sendProvisioningStatus(
      "{\"type\":\"error\",\"message\":\"Unsupported provisioning command.\"}"
    );
    return;
  }

  const String nextDeviceId = extractJsonString(payload, "deviceId");
  const String nextSiteId = extractJsonString(payload, "siteId");
  const String nextMachineLabel = extractJsonString(payload, "machineLabel");

  if (nextDeviceId.length() == 0) {
    sendProvisioningStatus(
      "{\"type\":\"error\",\"message\":\"Device ID is required.\"}"
    );
    return;
  }

  sendProvisioningStatus(
    "{\"type\":\"phase\",\"phase\":\"saving\",\"message\":\"Saving BLE device identity.\"}"
  );
  saveProvisioningConfig(nextDeviceId, nextSiteId, nextMachineLabel);
  sendProvisioningStatus(
    "{\"type\":\"provisioned\",\"deviceId\":\"" + escapeJsonString(nextDeviceId) +
    "\",\"siteId\":\"" + escapeJsonString(nextSiteId) + "\"}"
  );
}

void handleRuntimeControl(const String& payload) {
  const String type = extractJsonString(payload, "type");
  lastRuntimeControlAt = millis();

  if (type == "app-session-bootstrap") {
    disarmRuntimeBootstrapWatchdog();
    runtimeLeaseRequired = true;
    return;
  }

  if (type == "app-session-lease") {
    disarmRuntimeBootstrapWatchdog();
    runtimeLeaseRequired = true;
    const String sessionId = extractJsonString(payload, "sessionId");
    const unsigned long expiresInMs = extractJsonUnsignedLong(
      payload,
      "expiresInMs",
      APP_SESSION_LEASE_DEFAULT_MS
    );

    if (sessionId.length() == 0) {
      journalNodeLog(
        "warn",
        "runtime.app_session.invalid",
        "Ignored app session lease without a session id.",
        millis()
      );
      return;
    }

    markRuntimeAppSessionOnline(sessionId, expiresInMs, millis());
    return;
  }

  if (type == "sync-now") {
    disarmRuntimeBootstrapWatchdog();
    sendTelemetry(lastReportedDelta, millis(), true);
    return;
  }

  if (type == "ota-begin") {
    disarmRuntimeBootstrapWatchdog();
    beginOtaTransfer(payload);
    return;
  }

  if (type == "ota-end") {
    disarmRuntimeBootstrapWatchdog();
    completeOtaTransfer();
    return;
  }

  if (type == "ota-abort") {
    disarmRuntimeBootstrapWatchdog();
    abortOtaTransfer("ota-aborted-by-gateway");
    return;
  }

  if (type == "history-sync-begin") {
    disarmRuntimeBootstrapWatchdog();
    const unsigned long afterSequence = extractJsonUnsignedLong(payload, "afterSequence", 0);
    const size_t maxRecords = extractJsonSize(payload, "maxRecords", HISTORY_SYNC_PAGE_SIZE);
    streamHistoryRecords(afterSequence, maxRecords > 0 ? maxRecords : HISTORY_SYNC_PAGE_SIZE);
    return;
  }

  if (type == "history-ack") {
    disarmRuntimeBootstrapWatchdog();
    const unsigned long sequence = extractJsonUnsignedLong(payload, "sequence", 0);
    acknowledgeHistoryThrough(sequence);
    return;
  }
}

class GymServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    (void)server;
  }

  void onConnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
    provisioningBleConnected = true;
    runtimeBleConnected = true;
    runtimeBleConnectedAt = millis();
    lastDisconnectedAdvertisingLogAt = 0;
    lastConnectedRuntimeDebugAt = 0;
    runtimeBleConnIdKnown = param != nullptr;
    runtimeBleConnId = param != nullptr ? param->connect.conn_id : 0;
    resetRuntimeAppSessionState();
    armRuntimeBootstrapWatchdog(
      "BLE client connected; waiting for runtime or provisioning traffic."
    );
    sendProvisioningReady();
    sendTelemetry(lastReportedDelta, millis(), true);
  }

  void onDisconnect(BLEServer* server) override {
    (void)server;
  }

  void onDisconnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
    (void)param;
    provisioningBleConnected = false;
    runtimeBleConnected = false;
    runtimeBleConnectedAt = 0;
    lastConnectedRuntimeDebugAt = 0;
    noteRuntimeTransportDisconnected(millis());
    startRuntimeAdvertising("BLE client disconnected");
  }
};

class ProvisioningControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value(characteristic->getValue().c_str());

    if (value.length() == 0) {
      return;
    }

    disarmRuntimeBootstrapWatchdog();

    if (value.startsWith("BEGIN:")) {
      provisioningCommandBuffer = "";
      return;
    }

    if (value == "END") {
      const String command = provisioningCommandBuffer;
      provisioningCommandBuffer = "";
      handleProvisioningCommand(command);
      return;
    }

    provisioningCommandBuffer += value;
  }
};

class ProvisioningStatusDescriptorCallbacks : public BLEDescriptorCallbacks {
  void onWrite(BLEDescriptor* descriptor) override {
    if (descriptor == nullptr) {
      return;
    }

    const uint8_t* value = descriptor->getValue();
    const size_t length = descriptor->getLength();
    const bool notificationsEnabled =
      value != nullptr && length > 0 && (value[0] & 0x01) != 0;

    if (!notificationsEnabled) {
      return;
    }

    if (!runtimeBleConnected || !runtimeBootstrapLeasePending) {
      return;
    }

    disarmRuntimeBootstrapWatchdog();
    logRuntimeTransportEvent(
      "Provisioning status notifications enabled; leaving runtime lease watchdog idle."
    );
  }
};

class RuntimeControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value(characteristic->getValue().c_str());

    if (value.length() == 0) {
      return;
    }

    if (value.startsWith("BEGIN:")) {
      runtimeCommandBuffer = "";
      return;
    }

    if (value == "END") {
      const String command = runtimeCommandBuffer;
      runtimeCommandBuffer = "";
      handleRuntimeControl(command);
      return;
    }

    runtimeCommandBuffer += value;
  }
};

class RuntimeTelemetryCallbacks : public BLECharacteristicCallbacks {
#if defined(CONFIG_NIMBLE_ENABLED)
  void onSubscribe(
    BLECharacteristic* characteristic,
    ble_gap_conn_desc* desc,
    uint16_t subValue
  ) override {
    (void)characteristic;
    (void)desc;

    if (subValue == 0) {
      return;
    }

    if (runtimeLeaseRequired || runtimeBootstrapLeasePending) {
      return;
    }

    armRuntimeBootstrapWatchdog(
      "Runtime telemetry subscribed; waiting for runtime control traffic."
    );
  }
#endif
};

class RuntimeTelemetryDescriptorCallbacks : public BLEDescriptorCallbacks {
  void onWrite(BLEDescriptor* descriptor) override {
    if (descriptor == nullptr) {
      return;
    }

    const uint8_t* value = descriptor->getValue();
    const size_t length = descriptor->getLength();
    const bool notificationsEnabled =
      value != nullptr && length > 0 && (value[0] & 0x01) != 0;

    if (!notificationsEnabled) {
      return;
    }

    if (runtimeLeaseRequired || runtimeBootstrapLeasePending) {
      return;
    }

    armRuntimeBootstrapWatchdog(
      "Runtime telemetry notifications enabled; waiting for runtime control traffic."
    );
  }
};

class RuntimeOtaDataCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String stringValue = characteristic->getValue();
    const std::string value(stringValue.c_str(), stringValue.length());
    handleOtaDataWrite(value);
  }
};

void updateMotionState() {
  int16_t x, y, z;
  readAccel(x, y, z);

  if (!haveLastReading) {
    haveLastReading = true;
    lastMotionTime = millis();
    lastX = x;
    lastY = y;
    lastZ = z;
    Serial.println("Calibrating...");
    return;
  }

  const int delta = abs(x - lastX) + abs(y - lastY) + abs(z - lastZ);
  const unsigned long now = millis();

  if (delta > MOTION_THRESHOLD) {
    lastMotionTime = now;

    if (strcmp(currentDetectedState, "moving") != 0) {
      currentDetectedState = "moving";
      pendingMotionUpdate = true;
      journalMotionState(currentDetectedState, delta, now);
      Serial.println("Detected -> MOVING");
    }
  } else if (
    strcmp(currentDetectedState, "moving") == 0 &&
    now - lastMotionTime > STOP_TIMEOUT_MS
  ) {
    currentDetectedState = "still";
    pendingMotionUpdate = true;
    journalMotionState(currentDetectedState, delta, now);
    Serial.println("Detected -> STILL");
  }

  if (pendingMotionUpdate || now - lastTelemetryAt >= KEEPALIVE_INTERVAL_MS) {
    sendTelemetry(delta, now, pendingMotionUpdate);
  }

  lastX = x;
  lastY = y;
  lastZ = z;
}

void logConnectedRuntimeHeartbeat() {
  if (!runtimeBleConnected) {
    return;
  }

  const unsigned long now = millis();

  if (
    lastConnectedRuntimeDebugAt > 0 &&
    now - lastConnectedRuntimeDebugAt < CONNECTED_RUNTIME_DEBUG_INTERVAL_MS
  ) {
    return;
  }

  lastConnectedRuntimeDebugAt = now;
  logRuntimeLeaseState("Connected heartbeat.", now);
}

void logDisconnectedAdvertisingHeartbeat() {
  if (runtimeBleConnected || bleServer == nullptr) {
    return;
  }

  const unsigned long now = millis();

  if (
    lastDisconnectedAdvertisingLogAt > 0 &&
    now - lastDisconnectedAdvertisingLogAt < DISCONNECTED_ADVERTISING_LOG_INTERVAL_MS
  ) {
    return;
  }

  lastDisconnectedAdvertisingLogAt = now;
  logRuntimeTransportEvent(
    "Still waiting for the Windows app; BLE advertising is active."
  );
}

void setupBle() {
  BLEDevice::init(createBleDeviceName().c_str());
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new GymServerCallbacks());

  BLEService* provisioningService = bleServer->createService(PROVISIONING_SERVICE_UUID);
  provisioningControlCharacteristic = provisioningService->createCharacteristic(
    PROVISIONING_CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  provisioningStatusCharacteristic = provisioningService->createCharacteristic(
    PROVISIONING_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  provisioningControlCharacteristic->setCallbacks(new ProvisioningControlCallbacks());
  provisioningStatusDescriptor = new BLE2902();
  provisioningStatusDescriptor->setCallbacks(new ProvisioningStatusDescriptorCallbacks());
  provisioningStatusCharacteristic->addDescriptor(provisioningStatusDescriptor);
  provisioningStatusCharacteristic->setValue(createProvisioningReadyPayload().c_str());
  provisioningService->start();

  BLEService* runtimeService = bleServer->createService(RUNTIME_SERVICE_UUID);
  runtimeTelemetryCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_TELEMETRY_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  runtimeControlCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  runtimeStatusCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  runtimeOtaDataCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_OTA_DATA_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );

  runtimeTelemetryDescriptor = new BLE2902();
  runtimeTelemetryDescriptor->setCallbacks(new RuntimeTelemetryDescriptorCallbacks());
  runtimeTelemetryCharacteristic->addDescriptor(runtimeTelemetryDescriptor);
  runtimeStatusCharacteristic->addDescriptor(new BLE2902());
  runtimeTelemetryCharacteristic->setCallbacks(new RuntimeTelemetryCallbacks());
  runtimeControlCharacteristic->setCallbacks(new RuntimeControlCallbacks());
  runtimeOtaDataCharacteristic->setCallbacks(new RuntimeOtaDataCallbacks());
  runtimeService->start();

  BLEAdvertising* advertising = bleServer->getAdvertising();
  configureRuntimeAdvertisingPayload(advertising);
  advertising->start();
  lastDisconnectedAdvertisingLogAt = millis();
  logRuntimeTransportEvent(
    "BLE advertising started as " + createBleDeviceName() +
    " with runtime scan response."
  );
}

#ifdef CONFIG_APP_ROLLBACK_ENABLE
void finalizePendingRollback(bool healthy) {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t otaState;

  if (esp_ota_get_state_partition(running, &otaState) != ESP_OK) {
    return;
  }

  if (otaState != ESP_OTA_IMG_PENDING_VERIFY) {
    return;
  }

  if (healthy) {
    esp_ota_mark_app_valid_cancel_rollback();
  } else {
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}
#else
void finalizePendingRollback(bool healthy) {
  (void)healthy;
}
#endif

void setup() {
  Serial.begin(115200);
  delay(2000);

  pinMode(PROVISION_RESET_PIN, INPUT_PULLUP);
  preferences.begin(PREFS_NAMESPACE, false);
  hardwareId = createHardwareId();
  bootId = createBootId();
  loadProvisioningConfig();
  loadHistoryConfig();

  if (digitalRead(PROVISION_RESET_PIN) == LOW) {
    Serial.println("Provision reset button held. Clearing saved identity.");
    clearProvisioningConfig();
  }

  Wire.begin(SDA_PIN, SCL_PIN);
  setupADXL345();
  SPIFFS.begin(true);
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
  logConnectedRuntimeHeartbeat();
  logDisconnectedAdvertisingHeartbeat();
  updateMotionState();
  delay(LOOP_DELAY_MS);
}
