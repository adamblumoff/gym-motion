namespace {
constexpr unsigned long SENSOR_I2C_TIMEOUT_US = 4000;
constexpr unsigned long MOTION_SENSOR_RECOVERY_RETRY_MS = 1000;
unsigned long nextMotionSensorRecoveryAt = 0;
const char* lastMotionSensorTransportIssue = "sensor_i2c_unknown";

void recordTwimTimeout(const char* issue) {
  lastMotionSensorTransportIssue = issue;
}

void recordTwimErrorSource(uint32_t error) {
  if ((error & TWIM_ERRORSRC_ANACK_Msk) != 0) {
    lastMotionSensorTransportIssue = "sensor_i2c_anack";
    return;
  }

  if ((error & TWIM_ERRORSRC_DNACK_Msk) != 0) {
    lastMotionSensorTransportIssue = "sensor_i2c_dnack";
    return;
  }

  if ((error & TWIM_ERRORSRC_OVERRUN_Msk) != 0) {
    lastMotionSensorTransportIssue = "sensor_i2c_overrun";
    return;
  }

  lastMotionSensorTransportIssue = "sensor_i2c_unknown";
}

bool isMotionSensorLineHigh(uint8_t pin) {
  pinMode(pin, INPUT_PULLUP);
  delayMicroseconds(5);
  return digitalRead(pin) == HIGH;
}

void releaseMotionSensorClockHigh() {
  pinMode(PIN_WIRE_SCL, INPUT_PULLUP);
  delayMicroseconds(5);
}

void driveMotionSensorClockLow() {
  pinMode(PIN_WIRE_SCL, OUTPUT);
  digitalWrite(PIN_WIRE_SCL, LOW);
  delayMicroseconds(5);
}

void releaseMotionSensorDataHigh() {
  pinMode(PIN_WIRE_SDA, INPUT_PULLUP);
  delayMicroseconds(5);
}

void driveMotionSensorDataLow() {
  pinMode(PIN_WIRE_SDA, OUTPUT);
  digitalWrite(PIN_WIRE_SDA, LOW);
  delayMicroseconds(5);
}

bool clearMotionSensorBusIfNeeded() {
  const bool sclInitiallyHigh = isMotionSensorLineHigh(PIN_WIRE_SCL);
  const bool sdaInitiallyHigh = isMotionSensorLineHigh(PIN_WIRE_SDA);

  if (!sclInitiallyHigh) {
    motionSensorIssue = "sensor_bus_scl_low";
    return false;
  }

  if (sdaInitiallyHigh) {
    return true;
  }

  for (int pulse = 0; pulse < 9; ++pulse) {
    driveMotionSensorClockLow();
    releaseMotionSensorClockHigh();
  }

  driveMotionSensorDataLow();
  releaseMotionSensorClockHigh();
  releaseMotionSensorDataHigh();

  const bool sdaRecoveredHigh = isMotionSensorLineHigh(PIN_WIRE_SDA);
  const bool sclRecoveredHigh = isMotionSensorLineHigh(PIN_WIRE_SCL);

  if (!sclRecoveredHigh) {
    motionSensorIssue = "sensor_bus_scl_low";
    return false;
  }

  if (!sdaRecoveredHigh) {
    motionSensorIssue = "sensor_bus_sda_low";
    return false;
  }

  return true;
}

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
  const bool busIdle = clearMotionSensorBusIfNeeded();
  Wire.begin();
  Wire.setClock(100000);
  motionSensorReady = false;
  if (busIdle) {
    motionSensorIssue = "sensor_bus_recovery";
  }
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
    recordTwimTimeout("sensor_i2c_timeout_txstart");
    return false;
  }
  NRF_TWIM0->EVENTS_TXSTARTED = 0;

  if (length > 0) {
    if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_LASTTX, &NRF_TWIM0->EVENTS_ERROR)) {
      recordTwimTimeout("sensor_i2c_timeout_lasttx");
      return false;
    }
  }
  NRF_TWIM0->EVENTS_LASTTX = 0;

  if (stopBit || NRF_TWIM0->EVENTS_ERROR) {
    NRF_TWIM0->TASKS_STOP = 1;
    if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_STOPPED, &NRF_TWIM0->EVENTS_ERROR)) {
      recordTwimTimeout("sensor_i2c_timeout_txstop");
      return false;
    }
    NRF_TWIM0->EVENTS_STOPPED = 0;
  } else {
    NRF_TWIM0->TASKS_SUSPEND = 1;
    if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_SUSPENDED, &NRF_TWIM0->EVENTS_ERROR)) {
      recordTwimTimeout("sensor_i2c_timeout_txsuspend");
      return false;
    }
    NRF_TWIM0->EVENTS_SUSPENDED = 0;
  }

  if (NRF_TWIM0->EVENTS_ERROR) {
    const uint32_t error = NRF_TWIM0->ERRORSRC;
    recordTwimErrorSource(error);
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
    recordTwimTimeout("sensor_i2c_timeout_rxstart");
    return false;
  }
  NRF_TWIM0->EVENTS_RXSTARTED = 0;

  if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_LASTRX, &NRF_TWIM0->EVENTS_ERROR)) {
    recordTwimTimeout("sensor_i2c_timeout_lastrx");
    return false;
  }
  NRF_TWIM0->EVENTS_LASTRX = 0;

  NRF_TWIM0->TASKS_STOP = 1;
  if (!waitForTwimEvent(&NRF_TWIM0->EVENTS_STOPPED, &NRF_TWIM0->EVENTS_ERROR)) {
    recordTwimTimeout("sensor_i2c_timeout_rxstop");
    return false;
  }
  NRF_TWIM0->EVENTS_STOPPED = 0;

  if (NRF_TWIM0->EVENTS_ERROR) {
    const uint32_t error = NRF_TWIM0->ERRORSRC;
    recordTwimErrorSource(error);
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
  uint8_t whoAmI = 0;
  if (!readSensorRegisterBytes(STHS34PF80_REG_WHO_AM_I, &whoAmI, 1)) {
    Serial.println("STHS34PF80 WHO_AM_I read failed.");
    motionSensorReady = false;
    motionSensorIssue = lastMotionSensorTransportIssue;
    return;
  }

  if (whoAmI != STHS34PF80_WHO_AM_I_VALUE) {
    Serial.print("STHS34PF80 missing or unexpected WHO_AM_I: 0x");
    Serial.println(whoAmI, HEX);
    motionSensorReady = false;
    motionSensorIssue = "sensor_whoami_value";
    return;
  }

  if (!writeSensorRegisterMasked(STHS34PF80_REG_CTRL2, 0x80, 0x80)) {
    motionSensorReady = false;
    motionSensorIssue = "sensor_ctrl2_reset";
    return;
  }
  delay(5);
  if (!resetMotionSensorAlgorithm()) {
    motionSensorReady = false;
    motionSensorIssue = "sensor_algo_reset";
    return;
  }

  // Keep the algorithm in power-down while we restore the recommended defaults.
  if (!writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x0F, STHS34PF80_ODR_POWER_DOWN)) {
    motionSensorReady = false;
    motionSensorIssue = "sensor_ctrl1_power_down";
    return;
  }

  // Match the vendor library defaults, but keep a faster ODR for occupancy.
  if (!writeSensorRegisterMasked(STHS34PF80_REG_AVG_TRIM, 0x07, 0x02)) {
    motionSensorReady = false;
    motionSensorIssue = "sensor_avg_trim";
    return;
  }
  if (!writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x10, 0x10)) {
    motionSensorReady = false;
    motionSensorIssue = "sensor_ctrl1_bdu";
    return;
  }
  if (!writeSensorRegisterMasked(STHS34PF80_REG_CTRL1, 0x0F, STHS34PF80_ODR_15_HZ)) {
    motionSensorReady = false;
    motionSensorIssue = "sensor_ctrl1_odr";
    return;
  }

  motionSensorReady = true;
  motionSensorIssue = nullptr;
  Serial.println("STHS34PF80 motion sensor ready.");
}

void updateMotionState() {
  const unsigned long now = millis();
  const bool keepaliveDue = now - lastTelemetryAt >= KEEPALIVE_INTERVAL_MS;

  if (!motionSensorReady) {
    if (pendingMotionUpdate || keepaliveDue) {
      sendSensorIssueTelemetry(motionSensorIssue != nullptr ? motionSensorIssue : "sensor_unavailable", now);
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
  const bool recentFreshSample =
    haveLastReading &&
    lastFreshSensorSampleAt > 0 &&
    now - lastFreshSensorSampleAt <= SENSOR_SAMPLE_STALE_MS;

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
      if (recentFreshSample) {
        sendTelemetry(lastFreshSensorDelta, now, pendingMotionUpdate, pendingMotionUpdate);
      } else {
        sendSensorIssueTelemetry("sensor_no_data", now);
      }
    }

    return;
  }

  lastFreshSensorSampleAt = now;
  lastFreshSensorDelta = delta;

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
}
