#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>

// =========================
// Wi-Fi + API config
// =========================
const char* WIFI_SSID = "NEW 2WIRE280";
const char* WIFI_PASSWORD = "8968012359";
const char* API_URL = "https://gym-motion-production.up.railway.app/api/ingest";
const char* DEVICE_ID = "stack-001";

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
const unsigned long STOP_TIMEOUT_MS = 900;
const unsigned long LOOP_DELAY_MS = 25;

// =========================
// Network tuning
// =========================
const unsigned long RETRY_INTERVAL_MS = 750;
const unsigned long HEARTBEAT_INTERVAL_MS = 30000;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;
const uint16_t HTTP_TIMEOUT_MS = 1500;
const unsigned long DEBUG_PRINT_INTERVAL_MS = 250;

// =========================
// Motion state
// =========================
int16_t lastX = 0;
int16_t lastY = 0;
int16_t lastZ = 0;
bool haveLastReading = false;
unsigned long lastMotionTime = 0;

// =========================
// Shared send state
// =========================
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
const char* currentDetectedState = "still";
const char* lastSentState = "";
const char* pendingState = nullptr;

int pendingDelta = 0;
unsigned long pendingTimestamp = 0;

// =========================
// Send / retry state
// =========================
unsigned long lastSendAttemptMs = 0;
unsigned long lastHeartbeatMs = 0;
unsigned long lastWifiReconnectAttemptMs = 0;
unsigned long lastDebugPrintMs = 0;
int retryCount = 0;
TaskHandle_t senderTaskHandle = nullptr;

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

  unsigned long now = millis();
  if (now - lastWifiReconnectAttemptMs < WIFI_RECONNECT_INTERVAL_MS) return;

  lastWifiReconnectAttemptMs = now;
  Serial.println("Wi-Fi disconnected. Retrying...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// =========================
// Pending state helpers
// =========================
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

void maybeQueueHeartbeat() {
  unsigned long now = millis();
  bool shouldQueue = false;
  const char* detectedSnapshot = nullptr;

  portENTER_CRITICAL(&stateMux);
  if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS &&
      strcmp(currentDetectedState, lastSentState) == 0 &&
      pendingState == nullptr) {
    pendingState = currentDetectedState;
    pendingDelta = 0;
    pendingTimestamp = now;
    lastHeartbeatMs = now;
    detectedSnapshot = currentDetectedState;
    shouldQueue = true;
  }
  portEXIT_CRITICAL(&stateMux);

  if (shouldQueue) {
    Serial.print("Queued heartbeat -> ");
    Serial.println(detectedSnapshot);
  }
}

// =========================
// HTTP sender
// =========================
bool sendStateToServer(const char* state, int delta, unsigned long timestamp) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot send: Wi-Fi not connected.");
    return false;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);

  if (!http.begin(client, API_URL)) {
    Serial.println("HTTP begin failed.");
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  char payload[192];
  snprintf(
    payload,
    sizeof(payload),
    "{\"deviceId\":\"%s\",\"state\":\"%s\",\"timestamp\":%lu,\"delta\":%d}",
    DEVICE_ID,
    state,
    timestamp,
    delta
  );

  Serial.print("Send attempt -> ");
  Serial.println(payload);

  const int httpResponseCode = http.POST((uint8_t*)payload, strlen(payload));

  Serial.print("POST ");
  Serial.print(state);
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

void senderTask(void* parameter) {
  while (true) {
    ensureWiFiConnected();
    maybeQueueHeartbeat();

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

    vTaskDelay(pdMS_TO_TICKS(50));
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

  if (now - lastDebugPrintMs >= DEBUG_PRINT_INTERVAL_MS) {
    lastDebugPrintMs = now;
    Serial.print("delta: ");
    Serial.print(delta);
    Serial.print(" | detected: ");
    Serial.print(currentDetectedState);
    Serial.print(" | lastSent: ");
    Serial.print(lastSentState);
    Serial.print(" | pending: ");
    Serial.println(pendingState == nullptr ? "none" : pendingState);
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

  Wire.begin(SDA_PIN, SCL_PIN);
  setupADXL345();
  connectToWiFi();

  xTaskCreatePinnedToCore(
    senderTask,
    "senderTask",
    8192,
    nullptr,
    1,
    &senderTaskHandle,
    0
  );

  Serial.println("Motion detection ready");
}

void loop() {
  updateMotionState();
  delay(LOOP_DELAY_MS);
}
