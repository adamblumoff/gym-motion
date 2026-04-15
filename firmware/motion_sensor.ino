namespace {
constexpr unsigned long SENSOR_I2C_TIMEOUT_US = 4000;
constexpr unsigned long MOTION_SENSOR_RECOVERY_RETRY_MS = 1000;
unsigned long nextMotionSensorRecoveryAt = 0;

bool waitForTwimEvent(volatile uint32_t* eventRegister, volatile uint32_t* errorRegister) {
  const unsigned long startedAt = micros();

  while (*eventRegister == 0 && *errorRegister == 0) {
    if (static_cast<unsigned long>(micros() - startedAt) >= SENSOR_I2C_TIMEOUT_US) {
      return false;
    }
  }

  return true;
}

void recoverMotionSensorBus(const char* stage) {
  Serial.print("STHS34PF80 bus recovery: ");
  Serial.println(stage);
  Wire.end();
  delay(1);
  Wire.begin();
  Wire.setClock(100000);
  motionSensorReady = false;
  nextMotionSensorRecoveryAt = millis() + MOTION_SENSOR_RECOVERY_RETRY_MS;
}

bool twimWriteBytes(const uint8_t* data, size_t length, bool stopBit) {
  NRF_TWIM0->EVENTS_ERROR = 0;
  NRF_TWIM0->EVENTS_STOPPED = 0;
  NRF_TWIM0->EVENTS_TXSTARTED = 0;
  NRF_TWIM0->EVENTS_LASTTX = 0;
  NRF_TWIM0->EVENTS_SUSPENDED = 0;
  NRF_TWIM0->ADDRESS = STHS34PF80_ADDR;
  NRF_TWIM0->TASKS_RESUME = 1;
  NRF_TWIM0->TXD.PTR = reinterpret_cast<uint32_t>(data);
  NRF_TWIM0->TXD.MAXCNT = length;
  NRF_TWIM0->TASKS_STARTTX = 1;

  if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_TXSTARTED, &NRF_TWIM0->EVENTS_ERROR)) {
    return false;
  }
  NRF_TWIM0->EVENTS_TXSTARTED = 0;

  if (length > 0) {
    if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_LASTTX, &NRF_TWIM0->EVENTS_ERROR)) {
      return false;
    }
  }
  NRF_TWIM0->EVENTS_LASTTX = 0;

  if (stopBit || NRF_TWIM0->EVENTS_ERROR) {
    NRF_TWIM0->TASKS_STOP = 1;
    if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_STOPPED, &NRF_TWIM0->EVENTS_ERROR)) {
      return false;
    }
    NRF_TWIM0->EVENTS_STOPPED = 0;
  } else {
    NRF_TWIM0->TASKS_SUSPEND = 1;
    if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_SUSPENDED, &NRF_TWIM0->EVENTS_ERROR)) {
      return false;
    }
    NRF_TWIM0->EVENTS_SUSPENDED = 0;
  }

  if (NRF_TWIM0->EVENTS_ERROR) {
    const uint32_t error = NRF_TWIM0->ERRORSRC;
    NRF_TWIM0->EVENTS_ERROR = 0;
    NRF_TWIM0->ERRORSRC = error;
    return false;
  }

  return true;
}

bool twimReadBytes(uint8_t* data, size_t length) {
  NRF_TWIM0->EVENTS_ERROR = 0;
  NRF_TWIM0->EVENTS_STOPPED = 0;
  NRF_TWIM0->EVENTS_RXSTARTED = 0;
  NRF_TWIM0->EVENTS_LASTRX = 0;
  NRF_TWIM0->ADDRESS = STHS34PF80_ADDR;
  NRF_TWIM0->TASKS_RESUME = 1;
  NRF_TWIM0->RXD.PTR = reinterpret_cast<uint32_t>(data);
  NRF_TWIM0->RXD.MAXCNT = length;
  NRF_TWIM0->TASKS_STARTRX = 1;

  if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_RXSTARTED, &NRF_TWIM0->EVENTS_ERROR)) {
    return false;
  }
  NRF_TWIM0->EVENTS_RXSTARTED = 0;

  if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_LASTRX, &NRF_TWIM0->EVENTS_ERROR)) {
    return false;
  }
  NRF_TWIM0->EVENTS_LASTRX = 0;

  NRF_TWIM0->TASKS_STOP = 1;
  if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_STOPPED, &NRF_TWIM0->EVENTS_ERROR)) {
    return false;
  }
  NRF_TWIM0->EVENTS_STOPPED = 0;

  if (NRF_TWIM0->EVENTS_ERROR) {
    const uint32_t error = NRF_TWIM0->ERRORSRC;
    NRF_TWIM0->EVENTS_ERROR = 0;
    NRF_TWIM0->ERRORSRC = error;
    return false;
  }

  return true;
}

bool readSensorRegisterBytes(uint8_t reg, uint8_t* data, size_t length) {
  if (!twimWriteBytes(&reg, 1, false)) {
    recoverMotionSensorBus("register-address-write");
    return false;
  }

  if (!twimReadBytes(data, length)) {
    recoverMotionSensorBus("register-read");
    return false;
  }

  return true;
}
}

bool writeSensorRegister(uint8_t reg, uint8_t value) {
  const uint8_t payload[] = { reg, value };
  if (!twimWriteBytes(payload, sizeof(payload), true)) {
    recoverMotionSensorBus("register-write");
    return false;
  }

  return true;
}

bool writeSensorRegisterMasked(uint8_t reg, uint8_t mask, uint8_t value) {
  const uint8_t current = readSensorRegister8(reg);
  const uint8_t next = (current & ~mask) | (value & mask);
  return writeSensorRegister(reg, next);
}

uint8_t readSensorRegister8(uint8_t reg) {
  uint8_t value = 0;
  if (!readSensorRegisterBytes(reg, &value, 1)) {
    return 0;
  }

  return value;
}

int16_t readSensorRegister16(uint8_t reg) {
  uint8_t value[2] = { 0, 0 };
  if (!readSensorRegisterBytes(reg, value, sizeof(value))) {
    return 0;
  }

  const uint8_t low = value[0];
  const uint8_t high = value[1];
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
  (void)status;
  (void)dataReady;
  (void)funcStatus;
  (void)motionDetected;
  (void)presenceDetected;
  (void)motionValue;
  (void)presenceValue;
  (void)delta;
  (void)now;
  (void)force;
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
  const unsigned long now = millis();
  const bool keepaliveDue = now - lastTelemetryAt >= KEEPALIVE_INTERVAL_MS;

  if (!motionSensorReady) {
    if (pendingMotionUpdate || keepaliveDue) {
      sendTelemetry(lastReportedDelta, now, pendingMotionUpdate, false);
    }

    if (nextMotionSensorRecoveryAt == 0 || now >= nextMotionSensorRecoveryAt) {
      nextMotionSensorRecoveryAt = now + MOTION_SENSOR_RECOVERY_RETRY_MS;
      setupMotionSensor();
    }

    return;
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

    if (pendingMotionUpdate || keepaliveDue) {
      sendTelemetry(lastReportedDelta, now, pendingMotionUpdate, false);
    }

    return;
  }

  const bool deltaCrossedStart = delta >= MOTION_DELTA_START_THRESHOLD;
  const bool deltaClearedStop = delta <= MOTION_DELTA_STOP_THRESHOLD;

  if (deltaCrossedStart) {
    lastMotionTime = now;

    if (strcmp(currentDetectedState, "moving") != 0) {
      currentDetectedState = "moving";
      pendingMotionUpdate = true;
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
    deltaClearedStop &&
    now - lastMotionTime > MOTION_DELTA_STOP_HOLD_MS
  ) {
    currentDetectedState = "still";
    pendingMotionUpdate = true;
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

  if (pendingMotionUpdate || keepaliveDue) {
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
