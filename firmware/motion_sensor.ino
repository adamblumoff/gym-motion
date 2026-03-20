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
    sendTelemetry(delta, now, pendingMotionUpdate, pendingMotionUpdate);
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
