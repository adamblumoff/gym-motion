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

const char* FIRMWARE_VERSION = "0.5.3";
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
// The current desktop runtime talks to this node through the Windows WinRT
// sidecar handshake. Allow a little extra time for service discovery and the
// first bootstrap/control writes before we tear the client down as stale.
const unsigned long APP_SESSION_BOOTSTRAP_TIMEOUT_MS = 12000;
const unsigned long APP_SESSION_LEASE_DEFAULT_MS = 15000;
const unsigned long CONNECTED_RUNTIME_DEBUG_INTERVAL_MS = 5000;
const unsigned long DISCONNECTED_ADVERTISING_LOG_INTERVAL_MS = 10000;
const unsigned long OTA_RESTART_DELAY_MS = 1200;
const size_t HISTORY_MAX_BYTES = 48 * 1024;
const size_t HISTORY_RECLAIM_BYTES = 8 * 1024;
const size_t DEBUG_LOG_MAX_BYTES = 8 * 1024;
const size_t HISTORY_SYNC_PAGE_SIZE = 80;
const size_t STATUS_CHUNK_SIZE = 120;
const char* HISTORY_LOG_PATH = "/history.log";
const char* HISTORY_TEMP_PATH = "/history.tmp";
const char* DEBUG_LOG_PATH = "/debug.log";
const char* DEBUG_TEMP_PATH = "/debug.tmp";

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
String runtimeAppSessionNonce;
String runtimeBootstrapSessionNonce;

struct OtaTransferState {
  bool active = false;
  size_t expectedBytes = 0;
  size_t receivedBytes = 0;
  String expectedSha256;
  String targetVersion;
  mbedtls_sha256_context shaContext;
};

OtaTransferState otaTransfer;

void sendRuntimeStatus(const String& phase, const String& message, const String& version = "");
void sendTelemetry(int delta, unsigned long timestamp, bool force = false);

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
