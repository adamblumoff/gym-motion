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

String createMotionSensorDebugMessage(
  uint8_t status,
  bool dataReady,
  uint8_t funcStatus,
  bool motionDetected,
  bool presenceDetected,
  int16_t motionValue,
  int16_t presenceValue,
  int delta
) {
  return
    "status=0x" + String(status, HEX) +
    " drdy=" + String(dataReady ? 1 : 0) +
    " " +
    "func=0x" + String(funcStatus, HEX) +
    " mot=" + String(motionDetected ? 1 : 0) +
    " pres=" + String(presenceDetected ? 1 : 0) +
    " tmotion=" + String(motionValue) +
    " tpresence=" + String(presenceValue) +
    " delta=" + String(delta) +
    " state=" + String(currentDetectedState);
}

void logMotionSensorSample(
  uint8_t status,
  bool dataReady,
  uint8_t funcStatus,
  bool motionDetected,
  bool presenceDetected,
  int16_t motionValue,
  int16_t presenceValue,
  int delta,
  unsigned long now,
  bool force = false
) {
  const String message = createMotionSensorDebugMessage(
    status,
    dataReady,
    funcStatus,
    motionDetected,
    presenceDetected,
    motionValue,
    presenceValue,
    delta
  );

  if (!force &&
      lastMotionSensorDebugAt > 0 &&
      now - lastMotionSensorDebugAt < SENSOR_DEBUG_INTERVAL_MS) {
  } else {
    lastMotionSensorDebugAt = now;
    Serial.print("[motion] ");
    Serial.println(message);
  }

  if (!force &&
      lastMotionSensorHistoryLogAt > 0 &&
      now - lastMotionSensorHistoryLogAt < SENSOR_HISTORY_DEBUG_INTERVAL_MS) {
    return;
  }

  lastMotionSensorHistoryLogAt = now;
  journalNodeLog("debug", "sensor.motion.sample", message, now);
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

  // Keep the algorithm in power-down while we restore the recommended defaults.
  writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x0F, STHS34PF80_ODR_POWER_DOWN);

  // Match the vendor library defaults, but keep a faster ODR for occupancy.
  writeSensorRegisterMasked(STHS34PF80_REG_AVG_TRIM, 0x07, 0x02);
  writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x10, 0x10);
  writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x0F, STHS34PF80_ODR_15_HZ);

  motionSensorReady = true;
  Serial.println("STHS34PF80 motion sensor ready.");
}

void updateMotionState() {
  if (!motionSensorReady) {
    return;
  }

  const unsigned long now = millis();
  if (pendingMotionUpdate || now - lastTelemetryAt >= KEEPALIVE_INTERVAL_MS) {
    sendTelemetry(lastReportedDelta, now, false, false);
  }

  const uint8_t status = readSensorRegister8(STHS34PF80_REG_STATUS);
  const bool dataReady = (status & STHS34PF80_DRDY_FLAG) != 0;
  const uint8_t funcStatus = dataReady ? readSensorRegister8(STHS34PF80_REG_FUNC_STATUS) : 0;
  const bool motionDetected = (funcStatus & STHS34PF80_MOT_FLAG) != 0;
  const bool presenceDetected = (funcStatus & STHS34PF80_PRES_FLAG) != 0;
  const int16_t motionValue = dataReady ? readSensorRegister16(STHS34PF80_REG_TMOTION_L) : 0;
  const int16_t presenceValue = dataReady ? readSensorRegister16(STHS34PF80_REG_TPRESENCE_L) : 0;
  const int delta = max(abs(motionValue), abs(presenceValue));

  if (!haveLastReading) {
    haveLastReading = true;
    lastMotionTime = now;
    Serial.println("Calibrating STHS34PF80...");
    logMotionSensorSample(
      status,
      dataReady,
      funcStatus,
      motionDetected,
      presenceDetected,
      motionValue,
      presenceValue,
      delta,
      now,
      true
    );
    return;
  }

  if (!dataReady) {
    logMotionSensorSample(
      status,
      dataReady,
      funcStatus,
      motionDetected,
      presenceDetected,
      motionValue,
      presenceValue,
      delta,
      now
    );
    return;
  }

  if (motionDetected || presenceDetected) {
    lastMotionTime = now;

    if (strcmp(currentDetectedState, "moving") != 0) {
      currentDetectedState = "moving";
      pendingMotionUpdate = true;
      journalMotionState(currentDetectedState, delta, now);
      Serial.println("Detected -> MOVING");
      logMotionSensorSample(
        status,
        dataReady,
        funcStatus,
        motionDetected,
        presenceDetected,
        motionValue,
        presenceValue,
        delta,
        now,
        true
      );
    }
  } else if (
    strcmp(currentDetectedState, "moving") == 0 &&
    now - lastMotionTime > STOP_TIMEOUT_MS
  ) {
    currentDetectedState = "still";
    pendingMotionUpdate = true;
    journalMotionState(currentDetectedState, delta, now);
    Serial.println("Detected -> STILL");
    logMotionSensorSample(
      status,
      dataReady,
      funcStatus,
      motionDetected,
      presenceDetected,
      motionValue,
      presenceValue,
      delta,
      now,
      true
    );
  }

  logMotionSensorSample(
    status,
    dataReady,
    funcStatus,
    motionDetected,
    presenceDetected,
    motionValue,
    presenceValue,
    delta,
    now
  );

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
  enqueueBoardLogStatus(
    "runtime-heartbeat",
    "Connected heartbeat. appSession=" + String(runtimeAppSessionConnected ? 1 : 0) +
      " notifyMask=" + String(runtimeNotifyMask)
  );
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
