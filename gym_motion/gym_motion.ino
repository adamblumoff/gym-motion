#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

// =========================
// Wi-Fi + API config
// =========================
const char* WIFI_SSID = "NEW 2WIRE280";
const char* WIFI_PASSWORD = "8968012359";
const char* INGEST_URL = "https://gym-motion-production.up.railway.app/api/ingest";
const char* HEARTBEAT_URL = "https://gym-motion-production.up.railway.app/api/heartbeat";
const char* FIRMWARE_CHECK_URL = "https://gym-motion-production.up.railway.app/api/firmware/check";
const char* FIRMWARE_REPORT_URL = "https://gym-motion-production.up.railway.app/api/firmware/report";
const char* DEVICE_ID = "stack-001";
const char* FIRMWARE_VERSION = "0.4.1";

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
String hardwareId;
String bootId;

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
void connectToWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

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
  } else {
    Serial.println("Wi-Fi connect timed out.");
  }
}

void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) return;

  const unsigned long now = millis();
  if (now - lastWifiReconnectAttemptMs < WIFI_RECONNECT_INTERVAL_MS) return;

  lastWifiReconnectAttemptMs = now;
  Serial.println("Wi-Fi disconnected. Retrying...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
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

String toLowerCopy(String value) {
  value.toLowerCase();
  return value;
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
  char payload[320];
  snprintf(
    payload,
    sizeof(payload),
    "{\"deviceId\":\"%s\",\"state\":\"%s\",\"timestamp\":%lu,\"delta\":%d,\"bootId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareId\":\"%s\"}",
    DEVICE_ID,
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
  char payload[288];
  snprintf(
    payload,
    sizeof(payload),
    "{\"deviceId\":\"%s\",\"timestamp\":%lu,\"bootId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareId\":\"%s\"}",
    DEVICE_ID,
    timestamp,
    bootId.c_str(),
    FIRMWARE_VERSION,
    hardwareId.c_str()
  );

  return postJson(HEARTBEAT_URL, payload, "heartbeat");
}

bool sendFirmwareReport(const char* status, const String& targetVersion = "", const String& detail = "") {
  char payload[384];

  if (detail.length() > 0) {
    snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"%s\",\"status\":\"%s\",\"targetVersion\":\"%s\",\"detail\":\"%s\"}",
      DEVICE_ID,
      status,
      targetVersion.c_str(),
      detail.c_str()
    );
  } else if (targetVersion.length() > 0) {
    snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"%s\",\"status\":\"%s\",\"targetVersion\":\"%s\"}",
      DEVICE_ID,
      status,
      targetVersion.c_str()
    );
  } else {
    snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"%s\",\"status\":\"%s\"}",
      DEVICE_ID,
      status
    );
  }

  return postJson(FIRMWARE_REPORT_URL, payload, status, HTTP_TIMEOUT_MS);
}

// =========================
// OTA helpers
// =========================
bool fetchFirmwareRelease(FirmwareReleaseInfo& release) {
  String response;
  String url = String(FIRMWARE_CHECK_URL) +
    "?deviceId=" + String(DEVICE_ID) +
    "&firmwareVersion=" + String(FIRMWARE_VERSION);

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

bool downloadAndApplyFirmwareUnlocked(const FirmwareReleaseInfo& release) {
  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(OTA_HTTP_TIMEOUT_MS);
  http.setReuse(false);

  if (!http.begin(client, release.assetUrl)) {
    Serial.println("OTA HTTP begin failed.");
    return false;
  }

  const int httpResponseCode = http.GET();
  if (httpResponseCode != HTTP_CODE_OK) {
    Serial.print("OTA download failed -> HTTP ");
    Serial.println(httpResponseCode);
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
    http.end();
    return false;
  }

  if (release.sizeBytes > 0 && (size_t)contentLength != release.sizeBytes) {
    Serial.println("OTA content length did not match release metadata.");
    http.end();
    return false;
  }

  if (!Update.begin((size_t)contentLength)) {
    Serial.println("Update.begin failed.");
    Update.printError(Serial);
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
    Update.abort();
    return false;
  }

  const String actualSha256 = bytesToHex(digest, sizeof(digest));
  if (release.sha256.length() > 0 && actualSha256 != release.sha256) {
    Serial.println("OTA SHA-256 mismatch.");
    Update.abort();
    return false;
  }

  if (!Update.end()) {
    Serial.println("Update.end failed.");
    Update.printError(Serial);
    return false;
  }

  if (!Update.isFinished()) {
    Serial.println("OTA update was not marked finished.");
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

  if (!acquireNetworkLock(10000)) {
    Serial.println("Could not acquire network lock for OTA.");
    return false;
  }

  const bool ok = downloadAndApplyFirmwareUnlocked(release);
  releaseNetworkLock();

  if (!ok) {
    sendFirmwareReport("failed", release.version, "download-or-verify-failed");
    return false;
  }

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
      } else {
        Serial.print("Send failed. retryCount = ");
        Serial.println(retryCount);
      }
    }

    if (pendingState == nullptr && now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
      if (sendHeartbeat(now)) {
        lastHeartbeatMs = now;
        Serial.println("Heartbeat success.");
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

  hardwareId = createHardwareId();
  bootId = createBootId();
  networkMutex = xSemaphoreCreateMutex();

  Wire.begin(SDA_PIN, SCL_PIN);
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
  updateMotionState();
  delay(LOOP_DELAY_MS);
}
