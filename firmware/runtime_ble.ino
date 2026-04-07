BLEService provisioningService{BLEUuid(PROVISIONING_SERVICE_UUID)};
BLEService runtimeService{BLEUuid(RUNTIME_SERVICE_UUID)};
BLEService historyService{BLEUuid(HISTORY_SERVICE_UUID)};

BLECharacteristic provisioningControlCharacteristicImpl{BLEUuid(PROVISIONING_CONTROL_UUID)};
BLECharacteristic provisioningStatusCharacteristicImpl{BLEUuid(PROVISIONING_STATUS_UUID)};
BLECharacteristic runtimeTelemetryCharacteristicImpl{BLEUuid(RUNTIME_TELEMETRY_UUID)};
BLECharacteristic runtimeControlCharacteristicImpl{BLEUuid(RUNTIME_CONTROL_UUID)};
BLECharacteristic runtimeStatusCharacteristicImpl{BLEUuid(RUNTIME_STATUS_UUID)};
BLECharacteristic runtimeOtaDataCharacteristicImpl{BLEUuid(RUNTIME_OTA_DATA_UUID)};
BLECharacteristic historyControlCharacteristicImpl{BLEUuid(HISTORY_CONTROL_UUID)};
BLECharacteristic historyStatusCharacteristicImpl{BLEUuid(HISTORY_STATUS_UUID)};

String bytesToString(const uint8_t* data, size_t length) {
  String value;
  value.reserve(length);

  for (size_t index = 0; index < length; index++) {
    value += static_cast<char>(data[index]);
  }

  return value;
}

bool writeCharacteristicValue(BLECharacteristic* characteristic, const String& payload) {
  if (characteristic == nullptr) {
    return false;
  }

  return characteristic->write(payload.c_str()) > 0;
}

bool notifyCharacteristicValue(BLECharacteristic* characteristic, const String& payload) {
  if (characteristic == nullptr) {
    return false;
  }

  characteristic->write(payload.c_str());

  if (!runtimeBleConnIdKnown) {
    return true;
  }

  if (!characteristic->notifyEnabled(runtimeBleConnId)) {
    return true;
  }

  return characteristic->notify(runtimeBleConnId, payload.c_str());
}

void notifyCharacteristic(BLECharacteristic* characteristic, const String& payload) {
  if (characteristic == nullptr) {
    Serial.print("BLE notify skipped (missing characteristic): ");
    Serial.println(payload);
    return;
  }

  if (!provisioningBleConnected) {
    Serial.print("BLE notify skipped (runtime client disconnected): ");
    Serial.println(payload);
    return;
  }

  Serial.print("BLE notify sent: ");
  Serial.println(payload);
  notifyCharacteristicValue(characteristic, payload);
  delay(BLE_TX_MIN_INTERVAL_MS);
}

bool enqueueBleTxMessage(
  BleTxQueue& queue,
  BLECharacteristic* characteristic,
  bool* connectedFlag,
  const String& payload
) {
  if (characteristic == nullptr) {
    Serial.print("BLE queue skipped (missing characteristic): ");
    Serial.println(payload);
    return false;
  }

  if (connectedFlag == nullptr || !(*connectedFlag)) {
    Serial.print("BLE queue skipped (runtime client disconnected): ");
    Serial.println(payload);
    return false;
  }

  if (queue.length >= BLE_TX_QUEUE_CAPACITY) {
    Serial.print("BLE queue dropped (full): ");
    Serial.println(payload);
    return false;
  }

  BleTxMessage& entry = queue.entries[queue.tail];
  entry.characteristic = characteristic;
  entry.connectedFlag = connectedFlag;
  entry.payload = payload;
  queue.tail = (queue.tail + 1) % BLE_TX_QUEUE_CAPACITY;
  queue.length += 1;
  return true;
}

void enqueueChunkedNotification(
  BleTxQueue& queue,
  BLECharacteristic* characteristic,
  bool* connectedFlag,
  const String& payload
) {
  if (!enqueueBleTxMessage(queue, characteristic, connectedFlag, "BEGIN:" + String(payload.length()))) {
    return;
  }

  for (size_t offset = 0; offset < payload.length(); offset += STATUS_CHUNK_SIZE) {
    if (!enqueueBleTxMessage(
          queue,
          characteristic,
          connectedFlag,
          payload.substring(offset, offset + STATUS_CHUNK_SIZE)
        )) {
      return;
    }
  }

  enqueueBleTxMessage(queue, characteristic, connectedFlag, "END");
}

void enqueueRuntimeNotification(BLECharacteristic* characteristic, const String& payload) {
  enqueueBleTxMessage(runtimeTxQueue, characteristic, &runtimeBleConnected, payload);
}

void enqueueRuntimeNotificationChunked(BLECharacteristic* characteristic, const String& payload) {
  enqueueChunkedNotification(runtimeTxQueue, characteristic, &runtimeBleConnected, payload);
}

void enqueueHistoryNotification(BLECharacteristic* characteristic, const String& payload) {
  enqueueBleTxMessage(historyTxQueue, characteristic, &runtimeBleConnected, payload);
}

void enqueueHistoryNotificationChunked(BLECharacteristic* characteristic, const String& payload) {
  enqueueChunkedNotification(historyTxQueue, characteristic, &runtimeBleConnected, payload);
}

bool processBleTxMessage(BleTxQueue& queue) {
  if (queue.length == 0) {
    return false;
  }

  BleTxMessage entry = queue.entries[queue.head];
  queue.head = (queue.head + 1) % BLE_TX_QUEUE_CAPACITY;
  queue.length -= 1;

  if (entry.characteristic == nullptr || entry.connectedFlag == nullptr || !(*entry.connectedFlag)) {
    return false;
  }

  Serial.print("BLE notify sent: ");
  Serial.println(entry.payload);
  notifyCharacteristicValue(entry.characteristic, entry.payload);
  lastBleTxAt = millis();
  return true;
}

void processBleNotificationQueues() {
  const unsigned long now = millis();
  if (lastBleTxAt > 0 && now - lastBleTxAt < BLE_TX_MIN_INTERVAL_MS) {
    return;
  }

  while (runtimeTxQueue.length > 0) {
    if (processBleTxMessage(runtimeTxQueue)) {
      return;
    }
  }

  size_t historyBudget = BLE_TX_BURST_HISTORY_LIMIT;
  while (historyBudget > 0 && historyTxQueue.length > 0) {
    if (processBleTxMessage(historyTxQueue)) {
      return;
    }
    historyBudget -= 1;
  }
}

void sendProvisioningStatus(const String& payload) {
  notifyCharacteristic(provisioningStatusCharacteristic, payload);
}

String createRuntimeReadyPayload() {
  return
    "{\"type\":\"ready\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"bootUptimeMs\":" + String(millis()) +
    ",\"hardwareId\":\"" + escapeJsonString(hardwareId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"deviceName\":\"" + escapeJsonString(createBleDeviceName()) + "\"}";
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

void sendRuntimeStatus(const String& phase, const String& message, const String& version) {
  String payload = "{\"type\":\"ota-status\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"phase\":\"" + escapeJsonString(phase) +
    "\",\"message\":\"" + escapeJsonString(message) + "\"";

  if (version.length() > 0) {
    payload += ",\"version\":\"" + escapeJsonString(version) + "\"";
  }

  payload += "}";
  enqueueRuntimeNotificationChunked(runtimeStatusCharacteristic, payload);
}

void sendRuntimeAppSessionOnline(
  const String& sessionId,
  const String& sessionNonce
) {
  String payload =
    "{\"type\":\"app-session-online\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"sessionId\":\"" + escapeJsonString(sessionId) +
    "\",\"sessionNonce\":\"" + escapeJsonString(sessionNonce) +
    "\",\"firmwareVersion\":\"" + escapeJsonString(String(FIRMWARE_VERSION)) +
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}";
  enqueueRuntimeNotificationChunked(runtimeStatusCharacteristic, payload);
}

void logRuntimeTransportEvent(const String& message) {
  Serial.print("[runtime] ");
  Serial.println(message);
}

void logRuntimeHistoryEvent(const String& message) {
  Serial.print("[history] ");
  Serial.println(message);
}

void logAdvertisingSetupFailure(const char* field) {
  Serial.print("BLE advertising payload setup failed: ");
  Serial.println(field);
}

void configureRuntimeAdvertisingPayload() {
  Bluefruit.Advertising.stop();
  Bluefruit.Advertising.clearData();
  Bluefruit.ScanResponse.clearData();

  if (!Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE)) {
    logAdvertisingSetupFailure("flags");
  }

  if (!Bluefruit.Advertising.addTxPower()) {
    logAdvertisingSetupFailure("tx_power");
  }

  // Bluefruit can only encode a single 128-bit service UUID per advertising field.
  // Reconnect depends on the runtime service being visible during rediscovery, so
  // keep that UUID in the primary advertising packet and leave the name in scan response.
  if (!Bluefruit.Advertising.addService(runtimeService)) {
    logAdvertisingSetupFailure("runtime service");
  }

  if (!Bluefruit.ScanResponse.addName()) {
    logAdvertisingSetupFailure("device name");
  }

  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
}

void startRuntimeAdvertising(const String& reason) {
  if (!blePeripheralReady) {
    return;
  }

  configureRuntimeAdvertisingPayload();
  Bluefruit.Advertising.start(0);
  lastDisconnectedAdvertisingLogAt = millis();
  logRuntimeTransportEvent(
    "Advertising for Windows app reconnect (" + reason + ") as " +
    createBleDeviceName() + "."
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
  const firmware_runtime::AppSessionState state =
    firmware_runtime::createResetAppSessionState(APP_SESSION_LEASE_DEFAULT_MS);
  runtimeAppSessionConnected = state.runtimeAppSessionConnected;
  runtimeBootstrapLeasePending = state.runtimeBootstrapLeasePending;
  runtimeLeaseRequired = state.runtimeLeaseRequired;
  runtimeAppSessionId = state.runtimeAppSessionId.c_str();
  runtimeAppSessionNonce = state.runtimeAppSessionNonce.c_str();
  runtimeBootstrapSessionNonce = state.runtimeBootstrapSessionNonce.c_str();
  lastAppSessionLeaseAt = state.lastAppSessionLeaseAt;
  lastRuntimeControlAt = state.lastRuntimeControlAt;
  appSessionLeaseTimeoutMs = state.appSessionLeaseTimeoutMs;
  cancelHistoryWorker();
  lastCompletedHistoryRequestId = "";
}

void armRuntimeBootstrapWatchdog(const String& message) {
  firmware_runtime::AppSessionState state;
  state.runtimeBleConnected = runtimeBleConnected;
  state.runtimeBootstrapLeasePending = runtimeBootstrapLeasePending;
  state.runtimeLeaseRequired = runtimeLeaseRequired;

  if (!firmware_runtime::armBootstrapWatchdog(state)) {
    return;
  }

  runtimeBootstrapLeasePending = state.runtimeBootstrapLeasePending;
  logRuntimeTransportEvent(message);
}

void disarmRuntimeBootstrapWatchdog() {
  firmware_runtime::AppSessionState state;
  state.runtimeBootstrapLeasePending = runtimeBootstrapLeasePending;
  firmware_runtime::disarmBootstrapWatchdog(state);
  runtimeBootstrapLeasePending = state.runtimeBootstrapLeasePending;
}

void markRuntimeAppSessionOnline(
  const String& sessionId,
  const String& sessionNonce,
  unsigned long expiresInMs,
  unsigned long timestamp
) {
  firmware_runtime::AppSessionState state;
  state.runtimeAppSessionConnected = runtimeAppSessionConnected;
  state.runtimeAppSessionId = runtimeAppSessionId.c_str();
  state.runtimeAppSessionNonce = runtimeAppSessionNonce.c_str();
  state.lastAppSessionLeaseAt = lastAppSessionLeaseAt;
  state.lastRuntimeControlAt = lastRuntimeControlAt;
  state.appSessionLeaseTimeoutMs = appSessionLeaseTimeoutMs;
  state.runtimeBootstrapSessionNonce = runtimeBootstrapSessionNonce.c_str();

  const firmware_runtime::SessionOnlineUpdate update =
    firmware_runtime::markAppSessionOnline(
      state,
      sessionId.c_str(),
      sessionNonce.c_str(),
      expiresInMs,
      timestamp,
      APP_SESSION_LEASE_DEFAULT_MS
    );

  runtimeAppSessionConnected = state.runtimeAppSessionConnected;
  runtimeAppSessionId = state.runtimeAppSessionId.c_str();
  runtimeAppSessionNonce = state.runtimeAppSessionNonce.c_str();
  lastAppSessionLeaseAt = state.lastAppSessionLeaseAt;
  lastRuntimeControlAt = state.lastRuntimeControlAt;
  appSessionLeaseTimeoutMs = state.appSessionLeaseTimeoutMs;
  runtimeBootstrapSessionNonce = state.runtimeBootstrapSessionNonce.c_str();

  if (!update.sessionChanged) {
    logRuntimeLeaseState("Lease refreshed.", timestamp);
    return;
  }

  logRuntimeTransportEvent(
    "Windows app session lease is active for session " + sessionId + "."
  );
  sendRuntimeAppSessionOnline(sessionId, sessionNonce);

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
  const unsigned long now = millis();
  firmware_runtime::AppSessionState state;
  state.runtimeBleConnected = runtimeBleConnected;
  state.runtimeAppSessionConnected = runtimeAppSessionConnected;
  state.runtimeBootstrapLeasePending = runtimeBootstrapLeasePending;
  state.runtimeLeaseRequired = runtimeLeaseRequired;
  state.runtimeBleConnectedAt = runtimeBleConnectedAt;
  state.lastAppSessionLeaseAt = lastAppSessionLeaseAt;
  state.lastRuntimeControlAt = lastRuntimeControlAt;
  state.appSessionLeaseTimeoutMs = appSessionLeaseTimeoutMs;
  state.runtimeAppSessionId = runtimeAppSessionId.c_str();
  state.runtimeAppSessionNonce = runtimeAppSessionNonce.c_str();
  state.runtimeBootstrapSessionNonce = runtimeBootstrapSessionNonce.c_str();

  const firmware_runtime::LeaseEnforcementResult result =
    firmware_runtime::evaluateAppSessionLease(
      state,
      now,
      APP_SESSION_BOOTSTRAP_TIMEOUT_MS
    );

  if (result.kind == firmware_runtime::LeaseEnforcementResultKind::None) {
    return;
  }

  if (result.kind == firmware_runtime::LeaseEnforcementResultKind::BootstrapTimedOut) {
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

    if (runtimeBleConnIdKnown) {
      Bluefruit.disconnect(runtimeBleConnId);
      return;
    }

    startRuntimeAdvertising("missing runtime bootstrap");
    return;
  }

  if (result.kind == firmware_runtime::LeaseEnforcementResultKind::MissingLeaseTimedOut) {
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

    if (runtimeBleConnIdKnown) {
      Bluefruit.disconnect(runtimeBleConnId);
      return;
    }

    startRuntimeAdvertising("missing app-session lease");
    return;
  }

  logRuntimeLeaseState("Lease expiry timeout fired.", now);
  noteRuntimeAppSessionExpired(now);

  if (runtimeBleConnIdKnown) {
    Bluefruit.disconnect(runtimeBleConnId);
    return;
  }

  startRuntimeAdvertising("expired app-session lease");
}

void sendTelemetry(int delta, unsigned long timestamp, bool force, bool stateChanged) {
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
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) +
    "\",\"snapshot\":" + String(stateChanged ? "false" : "true") + "}";

  enqueueRuntimeNotificationChunked(runtimeTelemetryCharacteristic, payload);
  lastReportedState = currentDetectedState;
  lastReportedDelta = delta;
  lastTelemetryAt = timestamp;
  pendingMotionUpdate = false;
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
  const firmware_runtime::ControlCommand command =
    firmware_runtime::parseRuntimeControlCommand(
      payload.c_str(),
      APP_SESSION_LEASE_DEFAULT_MS
    );
  lastRuntimeControlAt = millis();

  if (command.type == firmware_runtime::ControlCommandType::AppSessionBootstrap) {
    disarmRuntimeBootstrapWatchdog();
    runtimeLeaseRequired = true;
    const String sessionNonce = command.sessionNonce.c_str();
    if (sessionNonce.length() == 0) {
      journalNodeLog(
        "warn",
        "runtime.app_session.invalid",
        "Ignored app session bootstrap without a session nonce.",
        millis()
      );
      runtimeLeaseRequired = false;
      return;
    }
    runtimeBootstrapSessionNonce = sessionNonce;
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::AppSessionLease) {
    disarmRuntimeBootstrapWatchdog();
    runtimeLeaseRequired = true;
    const String sessionId = command.sessionId.c_str();
    const unsigned long expiresInMs = command.expiresInMs;

    if (sessionId.length() == 0) {
      journalNodeLog(
        "warn",
        "runtime.app_session.invalid",
        "Ignored app session lease without a session id.",
        millis()
      );
      return;
    }

    if (runtimeBootstrapSessionNonce.length() == 0) {
      journalNodeLog(
        "warn",
        "runtime.app_session.invalid",
        "Ignored app session lease without a bootstrap session nonce.",
        millis()
      );
      return;
    }

    markRuntimeAppSessionOnline(
      sessionId,
      runtimeBootstrapSessionNonce,
      expiresInMs,
      millis()
    );
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::SyncNow) {
    disarmRuntimeBootstrapWatchdog();
    sendTelemetry(lastReportedDelta, millis(), true, false);
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::OtaBegin) {
    disarmRuntimeBootstrapWatchdog();
    beginOtaTransfer(payload);
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::OtaEnd) {
    disarmRuntimeBootstrapWatchdog();
    completeOtaTransfer();
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::OtaAbort) {
    disarmRuntimeBootstrapWatchdog();
    abortOtaTransfer("ota-aborted-by-gateway");
    return;
  }
}

void handleHistoryControl(const String& payload) {
  const firmware_runtime::HistoryControlCommand command =
    firmware_runtime::parseHistoryControlCommand(
      payload.c_str(),
      HISTORY_SYNC_PAGE_SIZE
    );

  if (command.type == firmware_runtime::HistoryControlCommandType::Unknown) {
    sendHistoryError("", "", "history.invalid_command", "Unsupported history control command.");
    return;
  }

  disarmRuntimeBootstrapWatchdog();
  lastRuntimeControlAt = millis();

  if (command.type == firmware_runtime::HistoryControlCommandType::HistoryPageRequest) {
    beginHistorySyncRequest(command);
    return;
  }

  if (command.type == firmware_runtime::HistoryControlCommandType::HistoryPageAck) {
    acknowledgeHistorySyncRequest(command);
    return;
  }
}

void handleProvisioningControlWrite(uint16_t conn_hdl, BLECharacteristic* characteristic, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)characteristic;
  const String value = bytesToString(data, len);

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

void handleRuntimeControlWrite(uint16_t conn_hdl, BLECharacteristic* characteristic, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)characteristic;
  const String value = bytesToString(data, len);

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

void handleHistoryControlWrite(uint16_t conn_hdl, BLECharacteristic* characteristic, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)characteristic;
  const String value = bytesToString(data, len);

  if (value.length() == 0) {
    return;
  }

  if (value.startsWith("BEGIN:")) {
    historyCommandBuffer = "";
    return;
  }

  if (value == "END") {
    const String command = historyCommandBuffer;
    historyCommandBuffer = "";
    handleHistoryControl(command);
    return;
  }

  historyCommandBuffer += value;
}

void handleRuntimeOtaDataWrite(uint16_t conn_hdl, BLECharacteristic* characteristic, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)characteristic;
  handleOtaDataWrite(data, len);
}

void handleProvisioningStatusCccd(uint16_t conn_hdl, BLECharacteristic* characteristic, uint16_t cccd_value) {
  (void)conn_hdl;
  (void)characteristic;

  const bool notificationsEnabled = (cccd_value & 0x0001) != 0;
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

void handleRuntimeTelemetryCccd(uint16_t conn_hdl, BLECharacteristic* characteristic, uint16_t cccd_value) {
  (void)conn_hdl;
  (void)characteristic;

  const bool notificationsEnabled = (cccd_value & 0x0001) != 0;
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

void handleBleConnect(uint16_t conn_handle) {
  provisioningBleConnected = true;
  runtimeBleConnected = true;
  runtimeBleConnectedAt = millis();
  lastDisconnectedAdvertisingLogAt = 0;
  lastConnectedRuntimeDebugAt = 0;
  runtimeBleConnIdKnown = true;
  runtimeBleConnId = conn_handle;
  resetRuntimeAppSessionState();
  armRuntimeBootstrapWatchdog(
    "BLE client connected; waiting for runtime or provisioning traffic."
  );

  BLEConnection* connection = Bluefruit.Connection(conn_handle);
  if (connection != nullptr) {
    connection->requestPHY();
    connection->requestDataLengthUpdate();
    connection->requestMtuExchange(247);
  }

  sendProvisioningReady();
  writeCharacteristicValue(runtimeStatusCharacteristic, createRuntimeReadyPayload());
  writeCharacteristicValue(historyStatusCharacteristic, createRuntimeReadyPayload());
  sendTelemetry(lastReportedDelta, millis(), true, false);
}

void handleBleDisconnect(uint16_t conn_handle, uint8_t reason) {
  (void)conn_handle;
  (void)reason;
  provisioningBleConnected = false;
  runtimeBleConnected = false;
  runtimeBleConnectedAt = 0;
  lastConnectedRuntimeDebugAt = 0;
  runtimeTxQueue = BleTxQueue();
  historyTxQueue = BleTxQueue();
  cancelHistoryWorker();
  lastCompletedHistoryRequestId = "";
  noteRuntimeTransportDisconnected(millis());
  startRuntimeAdvertising("BLE client disconnected");
}

bool setupBleCharacteristic(
  BLECharacteristic& characteristic,
  uint8_t properties,
  SecureMode_t readPermission,
  SecureMode_t writePermission,
  uint16_t maxLength
) {
  characteristic.setProperties(properties);
  characteristic.setPermission(readPermission, writePermission);
  characteristic.setMaxLen(maxLength);
  return characteristic.begin() == ERROR_NONE;
}

bool setupBleService(BLEService& service, const char* label) {
  const bool ok = service.begin() == ERROR_NONE;
  if (!ok) {
    Serial.print("BLE service registration failed: ");
    Serial.println(label);
  }
  return ok;
}

void setupBle() {
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);
  Bluefruit.configUuid128Count(16);
  Bluefruit.begin(1, 0);
  Bluefruit.setTxPower(4);
  Bluefruit.setName(createBleDeviceName().c_str());
  Bluefruit.Periph.setConnectCallback(handleBleConnect);
  Bluefruit.Periph.setDisconnectCallback(handleBleDisconnect);
  Bluefruit.Periph.setConnInterval(6, 12);

  setupBleService(provisioningService, "provisioning");
  if (!setupBleCharacteristic(
    provisioningControlCharacteristicImpl,
    CHR_PROPS_WRITE,
    SECMODE_NO_ACCESS,
    SECMODE_OPEN,
    244
  )) {
    Serial.println("BLE characteristic registration failed: provisioning control");
  }
  provisioningControlCharacteristicImpl.setWriteCallback(handleProvisioningControlWrite);

  if (!setupBleCharacteristic(
    provisioningStatusCharacteristicImpl,
    CHR_PROPS_READ | CHR_PROPS_NOTIFY,
    SECMODE_OPEN,
    SECMODE_NO_ACCESS,
    244
  )) {
    Serial.println("BLE characteristic registration failed: provisioning status");
  }
  provisioningStatusCharacteristicImpl.setCccdWriteCallback(handleProvisioningStatusCccd);
  provisioningStatusCharacteristicImpl.write(createProvisioningReadyPayload().c_str());

  setupBleService(runtimeService, "runtime");
  if (!setupBleCharacteristic(
    runtimeTelemetryCharacteristicImpl,
    CHR_PROPS_READ | CHR_PROPS_NOTIFY,
    SECMODE_OPEN,
    SECMODE_NO_ACCESS,
    244
  )) {
    Serial.println("BLE characteristic registration failed: runtime telemetry");
  }
  runtimeTelemetryCharacteristicImpl.setCccdWriteCallback(handleRuntimeTelemetryCccd);

  if (!setupBleCharacteristic(
    runtimeControlCharacteristicImpl,
    CHR_PROPS_WRITE,
    SECMODE_NO_ACCESS,
    SECMODE_OPEN,
    244
  )) {
    Serial.println("BLE characteristic registration failed: runtime control");
  }
  runtimeControlCharacteristicImpl.setWriteCallback(handleRuntimeControlWrite);

  if (!setupBleCharacteristic(
    runtimeStatusCharacteristicImpl,
    CHR_PROPS_READ | CHR_PROPS_NOTIFY,
    SECMODE_OPEN,
    SECMODE_NO_ACCESS,
    244
  )) {
    Serial.println("BLE characteristic registration failed: runtime status");
  }

  if (!setupBleCharacteristic(
    runtimeOtaDataCharacteristicImpl,
    CHR_PROPS_WRITE,
    SECMODE_NO_ACCESS,
    SECMODE_OPEN,
    244
  )) {
    Serial.println("BLE characteristic registration failed: runtime OTA data");
  }
  runtimeOtaDataCharacteristicImpl.setWriteCallback(handleRuntimeOtaDataWrite);
  runtimeStatusCharacteristicImpl.write(createRuntimeReadyPayload().c_str());

  setupBleService(historyService, "history");
  if (!setupBleCharacteristic(
    historyControlCharacteristicImpl,
    CHR_PROPS_WRITE,
    SECMODE_NO_ACCESS,
    SECMODE_OPEN,
    244
  )) {
    Serial.println("BLE characteristic registration failed: history control");
  }
  historyControlCharacteristicImpl.setWriteCallback(handleHistoryControlWrite);

  if (!setupBleCharacteristic(
    historyStatusCharacteristicImpl,
    CHR_PROPS_READ | CHR_PROPS_NOTIFY,
    SECMODE_OPEN,
    SECMODE_NO_ACCESS,
    244
  )) {
    Serial.println("BLE characteristic registration failed: history status");
  }
  historyStatusCharacteristicImpl.write(createRuntimeReadyPayload().c_str());

  provisioningControlCharacteristic = &provisioningControlCharacteristicImpl;
  provisioningStatusCharacteristic = &provisioningStatusCharacteristicImpl;
  runtimeTelemetryCharacteristic = &runtimeTelemetryCharacteristicImpl;
  runtimeControlCharacteristic = &runtimeControlCharacteristicImpl;
  runtimeStatusCharacteristic = &runtimeStatusCharacteristicImpl;
  runtimeOtaDataCharacteristic = &runtimeOtaDataCharacteristicImpl;
  historyControlCharacteristic = &historyControlCharacteristicImpl;
  historyStatusCharacteristic = &historyStatusCharacteristicImpl;

  blePeripheralReady = true;
  configureRuntimeAdvertisingPayload();
  Bluefruit.Advertising.start(0);
  lastDisconnectedAdvertisingLogAt = millis();
  logRuntimeTransportEvent(
    "BLE advertising started as " + createBleDeviceName() + "."
  );
}
