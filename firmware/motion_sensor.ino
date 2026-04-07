bool writeSensorRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(STHS34PF80_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool writeSensorRegisterMasked(uint8_t reg, uint8_t mask, uint8_t value) {
  const uint8_t current = readSensorRegister8(reg);
  const uint8_t next = (current & ~mask) | (value & mask);
  return writeSensorRegister(reg, next);
}

uint8_t readSensorRegister8(uint8_t reg) {
  Wire.beginTransmission(STHS34PF80_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return 0;
  }

  if (Wire.requestFrom(STHS34PF80_ADDR, static_cast<uint8_t>(1)) != 1) {
    return 0;
  }

  return Wire.read();
}

int16_t readSensorRegister16(uint8_t reg) {
  Wire.beginTransmission(STHS34PF80_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return 0;
  }

  if (Wire.requestFrom(STHS34PF80_ADDR, static_cast<uint8_t>(2)) != 2) {
    return 0;
  }

  const uint8_t low = Wire.read();
  const uint8_t high = Wire.read();
  return static_cast<int16_t>((high << 8) | low);
}

bool resetMotionSensorAlgorithm() {
  if (!writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x0F, 0x00)) {
    return false;
  }

  if (!writeSensorRegisterMasked(STHS34PF80_REG_CTRL2, 0x10, 0x10)) {
    return false;
  }

  if (!writeSensorRegisterMasked(STHS34PF80_REG_PAGE_RW, 0x40, 0x40)) {
    return false;
  }

  if (!writeSensorRegister(STHS34PF80_REG_FUNC_CFG_ADDR, STHS34PF80_EMBEDDED_RESET_ALGO)) {
    return false;
  }

  if (!writeSensorRegister(STHS34PF80_REG_FUNC_CFG_DATA, 0x01)) {
    return false;
  }

  if (!writeSensorRegisterMasked(STHS34PF80_REG_PAGE_RW, 0x40, 0x00)) {
    return false;
  }

  if (!writeSensorRegisterMasked(STHS34PF80_REG_CTRL2, 0x10, 0x00)) {
    return false;
  }

  return true;
}

void setupMotionSensor() {
  const uint8_t whoAmI = readSensorRegister8(STHS34PF80_REG_WHO_AM_I);
  if (whoAmI != STHS34PF80_WHO_AM_I_VALUE) {
    Serial.print("STHS34PF80 missing or unexpected WHO_AM_I: 0x");
    Serial.println(whoAmI, HEX);
    motionSensorReady = false;
    return;
  }

  writeSensorRegisterMasked(STHS34PF80_REG_CTRL2, 0x80, 0x80);
  delay(5);
  resetMotionSensorAlgorithm();

  // First tuning pass: sample faster and lighten filtering so motion changes
  // feel more responsive on the bench without changing detection thresholds yet.
  writeSensorRegisterMasked(STHS34PF80_REG_AVG_TRIM, 0x18, SENSOR_AMBIENT_AVG_CONFIG << 3);
  writeSensorRegisterMasked(STHS34PF80_REG_AVG_TRIM, 0x07, SENSOR_OBJECT_AVG_CONFIG);
  writeSensorRegisterMasked(
    STHS34PF80_REG_LPF1,
    0x38,
    SENSOR_MOTION_PRESENCE_LPF_CONFIG << 3
  );
  writeSensorRegisterMasked(STHS34PF80_REG_LPF1, 0x07, SENSOR_MOTION_LPF_CONFIG);
  writeSensorRegisterMasked(
    STHS34PF80_REG_LPF2,
    0x38,
    SENSOR_PRESENCE_LPF_CONFIG << 3
  );
  writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x10, 0x10);
  writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x0F, SENSOR_ODR_CONFIG);

  motionSensorReady = true;
  Serial.println("STHS34PF80 motion sensor ready (4Hz, avg8, LPF50, still=300ms).");
}

void updateMotionState() {
  if (!motionSensorReady) {
    return;
  }

  const uint8_t funcStatus = readSensorRegister8(STHS34PF80_REG_FUNC_STATUS);
  const bool motionDetected = (funcStatus & STHS34PF80_MOT_FLAG) != 0;
  const bool presenceDetected = (funcStatus & STHS34PF80_PRES_FLAG) != 0;
  const int16_t motionValue = readSensorRegister16(STHS34PF80_REG_TMOTION_L);
  const int16_t presenceValue = readSensorRegister16(STHS34PF80_REG_TPRESENCE_L);
  const int delta = max(abs(motionValue), abs(presenceValue));
  const unsigned long now = millis();

  if (!haveLastReading) {
    haveLastReading = true;
    lastMotionTime = now;
    Serial.println("Calibrating STHS34PF80...");
    return;
  }

  if (motionDetected || presenceDetected) {
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
  if (runtimeBleConnected || !blePeripheralReady) {
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
