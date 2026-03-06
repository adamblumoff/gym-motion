#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Update.h>
#include <Preferences.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

// =========================
// Wi-Fi + API config
// =========================
const char* INGEST_URL = "https://gym-motion-production.up.railway.app/api/ingest";
const char* HEARTBEAT_URL = "https://gym-motion-production.up.railway.app/api/heartbeat";
const char* FIRMWARE_CHECK_URL = "https://gym-motion-production.up.railway.app/api/firmware/check";
const char* FIRMWARE_REPORT_URL = "https://gym-motion-production.up.railway.app/api/firmware/report";
const char* DEVICE_LOG_URL = "https://gym-motion-production.up.railway.app/api/device-logs";
const char* FIRMWARE_VERSION = "0.4.3";
const int PROVISION_RESET_PIN = 0;
const char* PREFS_NAMESPACE = "gym-motion";
const char* PREF_WIFI_SSID = "wifi_ssid";
const char* PREF_WIFI_PASSWORD = "wifi_password";
const char* PREF_DEVICE_ID = "device_id";
const char* PREF_SITE_ID = "site_id";
const char* PREF_MACHINE_LABEL = "machine_label";

// =========================
// BLE provisioning config
// =========================
const char* PROVISIONING_SERVICE_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c201";
const char* PROVISIONING_CONTROL_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c202";
const char* PROVISIONING_STATUS_UUID = "8f7f5b70-7a1d-4c4a-a641-f7a6bcb7c203";

// =========================
// ADXL345 config
// =========================
const uint8_t ADXL345_ADDR = 0x53;
const int SDA_PIN = 21;
const int SCL_PIN = 22;

// =========================
// Motion tuning
// =========================
const int MOTION_THRESHOLD = 70;
const unsigned long STOP_TIMEOUT_MS = 600;
const unsigned long LOOP_DELAY_MS = 25;

// =========================
// Network tuning
// =========================
const unsigned long RETRY_INTERVAL_MS = 750;
const unsigned long HEARTBEAT_INTERVAL_MS = 30000;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;
const uint16_t HTTP_TIMEOUT_MS = 1500;
const uint16_t OTA_HTTP_TIMEOUT_MS = 20000;
const unsigned long OTA_CHECK_INTERVAL_MS = 10UL * 60UL * 1000UL;
const unsigned long OTA_BOOT_DELAY_MS = 15000;
const unsigned long OTA_IDLE_WINDOW_MS = 5000;

// =========================
// Motion state
// =========================
int16_t lastX = 0;
int16_t lastY = 0;
int16_t lastZ = 0;
bool haveLastReading = false;
unsigned long lastMotionTime = 0;

// =========================
// Shared state
// =========================
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
SemaphoreHandle_t networkMutex = nullptr;
const char* currentDetectedState = "still";
const char* lastSentState = "";
const char* pendingState = nullptr;
int pendingDelta = 0;
unsigned long pendingTimestamp = 0;
bool otaInProgress = false;
bool bootReportPending = true;
bool provisioningMode = false;
String hardwareId;
String bootId;
String configuredDeviceId;
String configuredSiteId;
String configuredMachineLabel;
String wifiSsid;
String wifiPassword;
Preferences preferences;
BLEServer* provisioningServer = nullptr;
BLECharacteristic* provisioningControlCharacteristic = nullptr;
BLECharacteristic* provisioningStatusCharacteristic = nullptr;
String provisioningCommandBuffer;
bool provisioningBleConnected = false;

// =========================
// Send / retry state
// =========================
unsigned long lastSendAttemptMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastWifiReconnectAttemptMs = 0;
unsigned long lastOtaCheckMs = 0;
int retryCount = 0;
TaskHandle_t senderTaskHandle = nullptr;
TaskHandle_t otaTaskHandle = nullptr;

struct FirmwareReleaseInfo {
  bool updateAvailable = false;
  String version;
  String assetUrl;
  String sha256;
  String md5;
  size_t sizeBytes = 0;
};

bool connectToWiFi();
void startProvisioningMode();
void sendProvisioningStatus(const String& payload);
void handleProvisioningCommand(const String& payload);
void sendProvisioningReady();
void runWifiScan();
void loadProvisioningConfig();
void clearProvisioningConfig();
void saveProvisioningConfig(
  const String& nextDeviceId,
  const String& nextSiteId,
  const String& nextMachineLabel,
  const String& nextWifiSsid,
  const String& nextWifiPassword
);

bool sendDeviceLog(
  const char* level,
  const char* code,
  const String& message,
  unsigned long timestamp = 0,
  const String& metadata = ""
);

// =========================
// OTA rollback helpers
// =========================
#ifdef CONFIG_APP_ROLLBACK_ENABLE
bool verifyRollbackLater() {
  return true;
}

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
    Serial.println("OTA image marked valid.");
  } else {
    Serial.println("OTA verification failed. Rolling back.");
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}
#else
void finalizePendingRollback(bool healthy) {
  (void)healthy;
}
#endif

// =========================
// ADXL345 helpers
// =========================
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

  x = (int16_t)((data[1] << 8) | data[0]);
  y = (int16_t)((data[3] << 8) | data[2]);
  z = (int16_t)((data[5] << 8) | data[4]);
}

void setupADXL345() {
  writeRegister(0x2D, 0x08); // measurement mode
  writeRegister(0x31, 0x08); // full res, +/-2g
}

// =========================
// Wi-Fi helpers
// =========================
bool connectToWiFi() {
  if (wifiSsid.length() == 0 || wifiPassword.length() == 0) {
    Serial.println("Wi-Fi credentials are not configured.");
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());

  Serial.print("Connecting to Wi-Fi");
  unsigned long start = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    sendDeviceLog("info", "wifi.connected", "Wi-Fi connected.", millis());
    return true;
  } else {
    Serial.println("Wi-Fi connect timed out.");
    sendDeviceLog("warn", "wifi.connect_timeout", "Wi-Fi connect timed out.", millis());
    return false;
  }
}

void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) return;

  const unsigned long now = millis();
  if (now - lastWifiReconnectAttemptMs < WIFI_RECONNECT_INTERVAL_MS) return;

  lastWifiReconnectAttemptMs = now;
  Serial.println("Wi-Fi disconnected. Retrying...");
  sendDeviceLog("warn", "wifi.reconnect", "Wi-Fi disconnected. Retrying.", now);
  if (wifiSsid.length() > 0 && wifiPassword.length() > 0) {
    WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  }
}

bool acquireNetworkLock(uint32_t timeoutMs = 5000) {
  if (networkMutex == nullptr) {
    return false;
  }

  return xSemaphoreTake(networkMutex, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
}

void releaseNetworkLock() {
  if (networkMutex != nullptr) {
    xSemaphoreGive(networkMutex);
  }
}

// =========================
// Utility helpers
// =========================
String createHardwareId() {
  const uint64_t chipId = ESP.getEfuseMac();
  char buffer[32];
  snprintf(
    buffer,
    sizeof(buffer),
    "esp32-%04x%08lx",
    (uint16_t)(chipId >> 32),
    (uint32_t)chipId
  );
  return String(buffer);
}

String createBootId() {
  const uint32_t randomValue = esp_random();
  char buffer[48];
  snprintf(buffer, sizeof(buffer), "%s-%08lx", hardwareId.c_str(), randomValue);
  return String(buffer);
}

bool hasProvisioningConfig() {
  return configuredDeviceId.length() > 0 &&
    wifiSsid.length() > 0 &&
    wifiPassword.length() > 0;
}

String createProvisioningDeviceName() {
  const int suffixStart = max(0, hardwareId.length() - 6);
  return "GymMotion-" + hardwareId.substring(suffixStart);
}

String toLowerCopy(String value) {
  value.toLowerCase();
  return value;
}

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

void loadProvisioningConfig() {
  configuredDeviceId = preferences.getString(PREF_DEVICE_ID, "");
  configuredSiteId = preferences.getString(PREF_SITE_ID, "");
  configuredMachineLabel = preferences.getString(PREF_MACHINE_LABEL, "");
  wifiSsid = preferences.getString(PREF_WIFI_SSID, "");
  wifiPassword = preferences.getString(PREF_WIFI_PASSWORD, "");
}

void clearProvisioningConfig() {
  preferences.remove(PREF_DEVICE_ID);
  preferences.remove(PREF_SITE_ID);
  preferences.remove(PREF_MACHINE_LABEL);
  preferences.remove(PREF_WIFI_SSID);
  preferences.remove(PREF_WIFI_PASSWORD);
  configuredDeviceId = "";
  configuredSiteId = "";
  configuredMachineLabel = "";
  wifiSsid = "";
  wifiPassword = "";
}

void saveProvisioningConfig(
  const String& nextDeviceId,
  const String& nextSiteId,
  const String& nextMachineLabel,
  const String& nextWifiSsid,
  const String& nextWifiPassword
) {
  preferences.putString(PREF_DEVICE_ID, nextDeviceId);
  preferences.putString(PREF_SITE_ID, nextSiteId);
  preferences.putString(PREF_MACHINE_LABEL, nextMachineLabel);
  preferences.putString(PREF_WIFI_SSID, nextWifiSsid);
  preferences.putString(PREF_WIFI_PASSWORD, nextWifiPassword);

  configuredDeviceId = nextDeviceId;
  configuredSiteId = nextSiteId;
  configuredMachineLabel = nextMachineLabel;
  wifiSsid = nextWifiSsid;
  wifiPassword = nextWifiPassword;
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

bool extractJsonBool(const String& json, const char* key, bool fallback = false) {
  const String token = "\"" + String(key) + "\":";
  const int start = json.indexOf(token);

  if (start < 0) {
    return fallback;
  }

  const int valueStart = start + token.length();
  return json.startsWith("true", valueStart);
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

  return (size_t)strtoull(json.substring(valueStart, valueEnd).c_str(), nullptr, 10);
}

bool isMotionIdle(unsigned long now) {
  bool idle = false;

  portENTER_CRITICAL(&stateMux);
  idle = pendingState == nullptr &&
    strcmp(currentDetectedState, "still") == 0 &&
    now - lastMotionTime >= OTA_IDLE_WINDOW_MS &&
    !otaInProgress;
  portEXIT_CRITICAL(&stateMux);

  return idle;
}

void setPendingState(const char* newState, int delta, unsigned long timestamp) {
  portENTER_CRITICAL(&stateMux);
  pendingState = newState;
  pendingDelta = delta;
  pendingTimestamp = timestamp;
  portEXIT_CRITICAL(&stateMux);

  Serial.print("Pending state set -> ");
  Serial.print(newState);
  Serial.print(" | delta: ");
  Serial.print(delta);
  Serial.print(" | millis: ");
  Serial.println(timestamp);
}

void sendProvisioningStatus(const String& payload) {
  Serial.print("BLE -> ");
  Serial.println(payload);

  if (provisioningStatusCharacteristic == nullptr || !provisioningBleConnected) {
    return;
  }

  provisioningStatusCharacteristic->setValue(payload.c_str());
  provisioningStatusCharacteristic->notify();
  delay(40);
}

void sendProvisioningReady() {
  sendProvisioningStatus(
    "{\"type\":\"ready\",\"hardwareId\":\"" + escapeJsonString(hardwareId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"deviceName\":\"" + escapeJsonString(createProvisioningDeviceName()) + "\"}"
  );
}

void runWifiScan() {
  sendProvisioningStatus(
    "{\"type\":\"phase\",\"phase\":\"scanning\",\"message\":\"Scanning nearby Wi-Fi networks.\"}"
  );

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  const int networkCount = WiFi.scanNetworks(false, true);
  String seen = "|";

  for (int index = 0; index < networkCount; index++) {
    const String ssid = WiFi.SSID(index);

    if (ssid.length() == 0 || seen.indexOf("|" + ssid + "|") >= 0) {
      continue;
    }

    seen += ssid + "|";
    sendProvisioningStatus(
      "{\"type\":\"scan-result\",\"ssid\":\"" + escapeJsonString(ssid) +
      "\",\"rssi\":" + String(WiFi.RSSI(index)) + "}"
    );
  }

  WiFi.scanDelete();
  sendProvisioningStatus("{\"type\":\"scan-complete\"}");
}

void startProvisioningMode();

void handleProvisioningCommand(const String& payload) {
  const String type = extractJsonString(payload, "type");

  if (type == "scan") {
    sendProvisioningReady();
    runWifiScan();
    return;
  }

  if (type != "provision") {
    sendProvisioningStatus(
      "{\"type\":\"error\",\"message\":\"Unsupported provisioning command.\"}"
    );
    return;
  }

  const String nextDeviceId = extractJsonString(payload, "deviceId");
  const String nextSiteId = extractJsonString(payload, "siteId");
  const String nextWifiSsid = extractJsonString(payload, "wifiSsid");
  const String nextWifiPassword = extractJsonString(payload, "wifiPassword");

  if (nextDeviceId.length() == 0 || nextWifiSsid.length() == 0 || nextWifiPassword.length() == 0) {
    sendProvisioningStatus(
      "{\"type\":\"error\",\"message\":\"Device ID and Wi-Fi credentials are required.\"}"
    );
    return;
  }

  sendProvisioningStatus(
    "{\"type\":\"phase\",\"phase\":\"saving\",\"message\":\"Saving Wi-Fi credentials on the device.\"}"
  );
  saveProvisioningConfig(
    nextDeviceId,
    nextSiteId,
    "",
    nextWifiSsid,
    nextWifiPassword
  );

  sendProvisioningStatus(
    "{\"type\":\"phase\",\"phase\":\"wifi-connecting\",\"message\":\"Joining the Wi-Fi network now.\"}"
  );

  if (!connectToWiFi()) {
    clearProvisioningConfig();
    startProvisioningMode();
    sendProvisioningStatus(
      "{\"type\":\"error\",\"message\":\"Could not join the Wi-Fi network.\"}"
    );
    return;
  }

  sendProvisioningStatus(
    "{\"type\":\"provisioned\",\"deviceId\":\"" + escapeJsonString(nextDeviceId) +
    "\",\"siteId\":\"" + escapeJsonString(nextSiteId) + "\"}"
  );
  sendProvisioningStatus(
    "{\"type\":\"phase\",\"phase\":\"restarting\",\"message\":\"Restarting into normal motion mode.\"}"
  );
  delay(600);
  ESP.restart();
}

class ProvisioningServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    provisioningBleConnected = true;
  }

  void onDisconnect(BLEServer* server) override {
    provisioningBleConnected = false;
    server->getAdvertising()->start();
  }
};

class ProvisioningControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const std::string rawValue = characteristic->getValue();

    if (rawValue.empty()) {
      return;
    }

    const String value(rawValue.c_str());

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

void startProvisioningMode() {
  provisioningMode = true;
  WiFi.disconnect(true, true);
  WiFi.mode(WIFI_MODE_NULL);

  if (provisioningServer != nullptr) {
    return;
  }

  BLEDevice::init(createProvisioningDeviceName().c_str());
  provisioningServer = BLEDevice::createServer();
  provisioningServer->setCallbacks(new ProvisioningServerCallbacks());

  BLEService* service = provisioningServer->createService(PROVISIONING_SERVICE_UUID);
  provisioningControlCharacteristic = service->createCharacteristic(
    PROVISIONING_CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  provisioningStatusCharacteristic = service->createCharacteristic(
    PROVISIONING_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );

  provisioningControlCharacteristic->setCallbacks(new ProvisioningControlCallbacks());
  provisioningStatusCharacteristic->addDescriptor(new BLE2902());
  provisioningStatusCharacteristic->setValue(
    "{\"type\":\"phase\",\"phase\":\"ble-connected\",\"message\":\"Ready for Bluetooth provisioning.\"}"
  );

  service->start();
  provisioningServer->getAdvertising()->addServiceUUID(PROVISIONING_SERVICE_UUID);
  provisioningServer->getAdvertising()->start();

  Serial.println("BLE provisioning mode ready.");
}

// =========================
// HTTP helpers
// =========================
bool postJsonUnlocked(const char* url, const char* payload, const char* label, uint16_t timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot send: Wi-Fi not connected.");
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setReuse(false);

  if (!http.begin(client, url)) {
    Serial.println("HTTP begin failed.");
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  Serial.print("Send attempt -> ");
  Serial.println(payload);

  const int httpResponseCode = http.POST((uint8_t*)payload, strlen(payload));

  Serial.print("POST ");
  Serial.print(label);
  Serial.print(" -> HTTP ");
  Serial.println(httpResponseCode);

  const bool ok = httpResponseCode >= 200 && httpResponseCode < 300;

  if (!ok) {
    if (httpResponseCode > 0) {
      Serial.print("Response body: ");
      Serial.println(http.getString());
    } else {
      Serial.print("HTTP error: ");
      Serial.println(http.errorToString(httpResponseCode));
    }
  }

  http.end();
  return ok;
}

bool postJson(const char* url, const char* payload, const char* label, uint16_t timeoutMs = HTTP_TIMEOUT_MS) {
  if (!acquireNetworkLock()) {
    Serial.println("Could not acquire network lock.");
    return false;
  }

  const bool ok = postJsonUnlocked(url, payload, label, timeoutMs);
  releaseNetworkLock();
  return ok;
}

bool getJson(const String& url, String& body, uint16_t timeoutMs = HTTP_TIMEOUT_MS) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  if (!acquireNetworkLock()) {
    Serial.println("Could not acquire network lock.");
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setReuse(false);

  bool ok = false;

  if (http.begin(client, url)) {
    const int httpResponseCode = http.GET();

    Serial.print("GET ");
    Serial.print(url);
    Serial.print(" -> HTTP ");
    Serial.println(httpResponseCode);

    if (httpResponseCode >= 200 && httpResponseCode < 300) {
      body = http.getString();
      ok = true;
    } else if (httpResponseCode > 0) {
      Serial.println(http.getString());
    } else {
      Serial.println(http.errorToString(httpResponseCode));
    }

    http.end();
  } else {
    Serial.println("HTTP GET begin failed.");
  }

  releaseNetworkLock();
  return ok;
}

bool sendStateToServer(const char* state, int delta, unsigned long timestamp) {
  if (configuredDeviceId.length() == 0) {
    return false;
  }

  char payload[320];
  snprintf(
    payload,
    sizeof(payload),
    "{\"deviceId\":\"%s\",\"state\":\"%s\",\"timestamp\":%lu,\"delta\":%d,\"bootId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareId\":\"%s\"}",
    configuredDeviceId.c_str(),
    state,
    timestamp,
    delta,
    bootId.c_str(),
    FIRMWARE_VERSION,
    hardwareId.c_str()
  );

  return postJson(INGEST_URL, payload, state);
}

bool sendHeartbeat(unsigned long timestamp) {
  if (configuredDeviceId.length() == 0) {
    return false;
  }

  char payload[288];
  snprintf(
    payload,
    sizeof(payload),
    "{\"deviceId\":\"%s\",\"timestamp\":%lu,\"bootId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareId\":\"%s\"}",
    configuredDeviceId.c_str(),
    timestamp,
    bootId.c_str(),
    FIRMWARE_VERSION,
    hardwareId.c_str()
  );

  return postJson(HEARTBEAT_URL, payload, "heartbeat");
}

bool sendFirmwareReport(const char* status, const String& targetVersion = "", const String& detail = "") {
  if (configuredDeviceId.length() == 0) {
    return false;
  }

  char payload[384];

  if (detail.length() > 0) {
    snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"%s\",\"status\":\"%s\",\"targetVersion\":\"%s\",\"detail\":\"%s\"}",
      configuredDeviceId.c_str(),
      status,
      targetVersion.c_str(),
      detail.c_str()
    );
  } else if (targetVersion.length() > 0) {
    snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"%s\",\"status\":\"%s\",\"targetVersion\":\"%s\"}",
      configuredDeviceId.c_str(),
      status,
      targetVersion.c_str()
    );
  } else {
    snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"%s\",\"status\":\"%s\"}",
      configuredDeviceId.c_str(),
      status
    );
  }

  return postJson(FIRMWARE_REPORT_URL, payload, status, HTTP_TIMEOUT_MS);
}

bool sendDeviceLog(
  const char* level,
  const char* code,
  const String& message,
  unsigned long timestamp,
  const String& metadata
) {
  if (configuredDeviceId.length() == 0) {
    return false;
  }

  String payload = "{";
  payload += "\"deviceId\":\"" + escapeJsonString(configuredDeviceId) + "\",";
  payload += "\"level\":\"" + String(level) + "\",";
  payload += "\"code\":\"" + String(code) + "\",";
  payload += "\"message\":\"" + escapeJsonString(message) + "\",";
  payload += "\"bootId\":\"" + escapeJsonString(bootId) + "\",";
  payload += "\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) + "\",";
  payload += "\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"";

  if (timestamp > 0) {
    payload += ",\"timestamp\":" + String(timestamp);
  }

  if (metadata.length() > 0) {
    payload += ",\"metadata\":" + metadata;
  }

  payload += "}";

  return postJson(DEVICE_LOG_URL, payload.c_str(), code, HTTP_TIMEOUT_MS);
}

// =========================
// OTA helpers
// =========================
bool fetchFirmwareRelease(FirmwareReleaseInfo& release) {
  if (configuredDeviceId.length() == 0) {
    return false;
  }

  String response;
  String url = String(FIRMWARE_CHECK_URL) +
    "?deviceId=" + configuredDeviceId +
    "&firmwareVersion=" + String(FIRMWARE_VERSION);

  sendDeviceLog("info", "ota.check", "Checking for firmware updates.", millis());

  if (!getJson(url, response)) {
    return false;
  }

  release.updateAvailable = extractJsonBool(response, "updateAvailable", false);
  release.version = extractJsonString(response, "version");
  release.assetUrl = extractJsonString(response, "assetUrl");
  release.sha256 = toLowerCopy(extractJsonString(response, "sha256"));
  release.md5 = toLowerCopy(extractJsonString(response, "md5"));
  release.sizeBytes = extractJsonSize(response, "sizeBytes", 0);

  return true;
}

bool downloadAndApplyFirmwareUnlocked(const FirmwareReleaseInfo& release, String& failureReason) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(OTA_HTTP_TIMEOUT_MS);
  http.setReuse(false);

  if (!http.begin(client, release.assetUrl)) {
    Serial.println("OTA HTTP begin failed.");
    failureReason = "http-begin-failed";
    return false;
  }

  const int httpResponseCode = http.GET();
  if (httpResponseCode != HTTP_CODE_OK) {
    Serial.print("OTA download failed -> HTTP ");
    Serial.println(httpResponseCode);
    failureReason = "http-status-" + String(httpResponseCode);
    if (httpResponseCode > 0) {
      Serial.println(http.getString());
    } else {
      Serial.println(http.errorToString(httpResponseCode));
    }
    http.end();
    return false;
  }

  const int contentLength = http.getSize();
  if (contentLength <= 0) {
    Serial.println("OTA content length missing.");
    failureReason = "content-length-missing";
    http.end();
    return false;
  }

  if (release.sizeBytes > 0 && (size_t)contentLength != release.sizeBytes) {
    Serial.println("OTA content length did not match release metadata.");
    failureReason = "content-length-mismatch";
    http.end();
    return false;
  }

  if (!Update.begin((size_t)contentLength)) {
    Serial.println("Update.begin failed.");
    Update.printError(Serial);
    failureReason = "update-begin-failed";
    http.end();
    return false;
  }

  if (release.md5.length() == 32) {
    Update.setMD5(release.md5.c_str());
  }

  WiFiClient* stream = http.getStreamPtr();
  mbedtls_sha256_context shaContext;
  mbedtls_sha256_init(&shaContext);
  mbedtls_sha256_starts(&shaContext, 0);

  uint8_t buffer[1024];
  size_t totalWritten = 0;
  unsigned long idleSince = millis();

  while (totalWritten < (size_t)contentLength) {
    const size_t availableBytes = stream->available();

    if (availableBytes == 0) {
      if (!http.connected() && totalWritten < (size_t)contentLength) {
        break;
      }

      if (millis() - idleSince > OTA_HTTP_TIMEOUT_MS) {
        Serial.println("OTA download stalled.");
        failureReason = "download-stalled";
        Update.abort();
        mbedtls_sha256_free(&shaContext);
        http.end();
        return false;
      }

      delay(1);
      continue;
    }

    const size_t toRead = min(sizeof(buffer), availableBytes);
    const size_t bytesRead = stream->readBytes(buffer, toRead);

    if (bytesRead == 0) {
      continue;
    }

    idleSince = millis();
    mbedtls_sha256_update(&shaContext, buffer, bytesRead);

    if (Update.write(buffer, bytesRead) != bytesRead) {
      Serial.println("Update.write failed.");
      Update.printError(Serial);
      failureReason = "update-write-failed";
      Update.abort();
      mbedtls_sha256_free(&shaContext);
      http.end();
      return false;
    }

    totalWritten += bytesRead;
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&shaContext, digest);
  mbedtls_sha256_free(&shaContext);
  http.end();

  if (totalWritten != (size_t)contentLength) {
    Serial.println("OTA download did not finish.");
    failureReason = "download-incomplete";
    Update.abort();
    return false;
  }

  const String actualSha256 = bytesToHex(digest, sizeof(digest));
  if (release.sha256.length() > 0 && actualSha256 != release.sha256) {
    Serial.println("OTA SHA-256 mismatch.");
    failureReason = "sha256-mismatch";
    Update.abort();
    return false;
  }

  if (!Update.end()) {
    Serial.println("Update.end failed.");
    Update.printError(Serial);
    failureReason = "update-end-failed";
    return false;
  }

  if (!Update.isFinished()) {
    Serial.println("OTA update was not marked finished.");
    failureReason = "update-not-finished";
    return false;
  }

  Serial.print("OTA ready for reboot -> ");
  Serial.println(release.version);
  return true;
}

bool performOtaUpdate(const FirmwareReleaseInfo& release) {
  if (!sendFirmwareReport("downloading", release.version)) {
    Serial.println("Could not report OTA downloading state.");
  }

  sendDeviceLog(
    "info",
    "ota.download.start",
    "Starting OTA download.",
    millis(),
    "{\"targetVersion\":\"" + escapeJsonString(release.version) + "\"}"
  );

  if (!acquireNetworkLock(10000)) {
    Serial.println("Could not acquire network lock for OTA.");
    sendDeviceLog("error", "ota.lock_failed", "Could not acquire network lock for OTA.", millis());
    return false;
  }

  String failureReason;
  const bool ok = downloadAndApplyFirmwareUnlocked(release, failureReason);
  releaseNetworkLock();

  if (!ok) {
    sendFirmwareReport("failed", release.version, "download-or-verify-failed");
    String metadata = "{\"targetVersion\":\"" + escapeJsonString(release.version) + "\"";
    if (failureReason.length() > 0) {
      metadata += ",\"reason\":\"" + escapeJsonString(failureReason) + "\"";
    }
    metadata += "}";
    sendDeviceLog("error", "ota.failed", "OTA update failed.", millis(), metadata);
    return false;
  }

  sendDeviceLog(
    "info",
    "ota.applied",
    "OTA image written successfully. Rebooting.",
    millis(),
    "{\"targetVersion\":\"" + escapeJsonString(release.version) + "\"}"
  );
  sendFirmwareReport("applied", release.version);
  delay(500);
  ESP.restart();
  return true;
}

// =========================
// Background tasks
// =========================
void senderTask(void* parameter) {
  while (true) {
    ensureWiFiConnected();

    if (otaInProgress) {
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    if (bootReportPending && WiFi.status() == WL_CONNECTED) {
      if (sendFirmwareReport("booted", FIRMWARE_VERSION)) {
        bootReportPending = false;
        sendDeviceLog("info", "firmware.booted", "Firmware booted and checked in.", millis());
      }
    }

    const unsigned long now = millis();
    const char* stateToSend = nullptr;
    int deltaToSend = 0;
    unsigned long timestampToSend = 0;
    bool shouldSend = false;

    portENTER_CRITICAL(&stateMux);
    if (pendingState != nullptr && now - lastSendAttemptMs >= RETRY_INTERVAL_MS) {
      if (strcmp(pendingState, lastSentState) == 0) {
        pendingState = nullptr;
        retryCount = 0;
      } else {
        stateToSend = pendingState;
        deltaToSend = pendingDelta;
        timestampToSend = pendingTimestamp;
        lastSendAttemptMs = now;
        shouldSend = true;
      }
    }
    portEXIT_CRITICAL(&stateMux);

    if (shouldSend) {
      const bool ok = sendStateToServer(stateToSend, deltaToSend, timestampToSend);

      portENTER_CRITICAL(&stateMux);
      if (ok) {
        if (pendingState == stateToSend && pendingTimestamp == timestampToSend) {
          lastSentState = stateToSend;
          pendingState = nullptr;
        } else {
          lastSentState = stateToSend;
        }
        retryCount = 0;
        lastHeartbeatMs = millis();
      } else {
        retryCount++;
      }
      portEXIT_CRITICAL(&stateMux);

      if (ok) {
        Serial.print("Send success. lastSentState -> ");
        Serial.println(stateToSend);
        sendDeviceLog(
          "info",
          "motion.state",
          String("State update sent: ") + stateToSend,
          timestampToSend,
          "{\"state\":\"" + String(stateToSend) + "\",\"delta\":" + String(deltaToSend) + "}"
        );
      } else {
        Serial.print("Send failed. retryCount = ");
        Serial.println(retryCount);
      }
    }

    if (pendingState == nullptr && now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
      if (sendHeartbeat(now)) {
        lastHeartbeatMs = now;
        Serial.println("Heartbeat success.");
        sendDeviceLog("info", "heartbeat.success", "Heartbeat sent successfully.", now);
      } else {
        sendDeviceLog("warn", "heartbeat.failed", "Heartbeat failed.", now);
      }
    }

    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void otaTask(void* parameter) {
  vTaskDelay(pdMS_TO_TICKS(OTA_BOOT_DELAY_MS));

  while (true) {
    const unsigned long now = millis();

    if (now - lastOtaCheckMs < OTA_CHECK_INTERVAL_MS) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    if (WiFi.status() != WL_CONNECTED || !isMotionIdle(now)) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    lastOtaCheckMs = now;

    FirmwareReleaseInfo release;
    if (!fetchFirmwareRelease(release)) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    if (!release.updateAvailable) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    Serial.print("Firmware update available -> ");
    Serial.println(release.version);
    sendDeviceLog(
      "info",
      "ota.available",
      "Firmware update available.",
      now,
      "{\"targetVersion\":\"" + escapeJsonString(release.version) + "\"}"
    );

    portENTER_CRITICAL(&stateMux);
    otaInProgress = true;
    portEXIT_CRITICAL(&stateMux);

    const bool started = performOtaUpdate(release);

    portENTER_CRITICAL(&stateMux);
    otaInProgress = false;
    portEXIT_CRITICAL(&stateMux);

    if (!started) {
      Serial.println("OTA update failed. Continuing on current firmware.");
    }

    vTaskDelay(pdMS_TO_TICKS(2000));
  }
}

// =========================
// Motion detection
// =========================
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
      Serial.println("Detected -> MOVING");
      setPendingState("moving", delta, now);
    }
  } else if (strcmp(currentDetectedState, "moving") == 0 &&
             now - lastMotionTime > STOP_TIMEOUT_MS) {
    currentDetectedState = "still";
    Serial.println("Detected -> STILL");
    setPendingState("still", delta, now);
  }

  lastX = x;
  lastY = y;
  lastZ = z;
}

// =========================
// Setup / loop
// =========================
void setup() {
  Serial.begin(115200);
  delay(2000);

  pinMode(PROVISION_RESET_PIN, INPUT_PULLUP);
  hardwareId = createHardwareId();
  bootId = createBootId();
  networkMutex = xSemaphoreCreateMutex();
  preferences.begin(PREFS_NAMESPACE, false);
  loadProvisioningConfig();

  if (digitalRead(PROVISION_RESET_PIN) == LOW) {
    Serial.println("Provision reset button held. Clearing saved Wi-Fi.");
    clearProvisioningConfig();
  }

  Wire.begin(SDA_PIN, SCL_PIN);
  if (!hasProvisioningConfig()) {
    startProvisioningMode();
    finalizePendingRollback(true);
    return;
  }

  setupADXL345();
  connectToWiFi();

  lastHeartbeatMs = millis() - HEARTBEAT_INTERVAL_MS;
  lastOtaCheckMs = millis() - OTA_CHECK_INTERVAL_MS + OTA_BOOT_DELAY_MS;

  Serial.print("Hardware ID: ");
  Serial.println(hardwareId);
  Serial.print("Boot ID: ");
  Serial.println(bootId);
  Serial.print("Firmware version: ");
  Serial.println(FIRMWARE_VERSION);
  sendDeviceLog("info", "device.boot", "Device boot complete.", millis());

  const BaseType_t senderResult = xTaskCreatePinnedToCore(
    senderTask,
    "senderTask",
    8192,
    nullptr,
    1,
    &senderTaskHandle,
    0
  );

  const BaseType_t otaResult = xTaskCreatePinnedToCore(
    otaTask,
    "otaTask",
    12288,
    nullptr,
    1,
    &otaTaskHandle,
    0
  );

  if (networkMutex == nullptr || senderResult != pdPASS || otaResult != pdPASS) {
    Serial.println("Task initialization failed.");
    finalizePendingRollback(false);
    return;
  }

  finalizePendingRollback(true);
  Serial.println("Motion detection ready");
}

void loop() {
  if (provisioningMode) {
    delay(50);
    return;
  }

  updateMotionState();
  delay(LOOP_DELAY_MS);
}
