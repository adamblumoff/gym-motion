void notifyCharacteristic(BLECharacteristic* characteristic, bool connected, const String& payload) {
  if (characteristic == nullptr) {
    Serial.print("BLE notify skipped (missing characteristic): ");
    Serial.println(payload);
    return;
  }

  if (!connected) {
    Serial.print("BLE notify skipped (runtime client disconnected): ");
    Serial.println(payload);
    return;
  }

  Serial.print("BLE notify sent: ");
  Serial.println(payload);
  characteristic->setValue(payload.c_str());
  characteristic->notify();
  delay(30);
}

void notifyCharacteristicChunked(BLECharacteristic* characteristic, bool connected, const String& payload) {
  if (characteristic == nullptr) {
    Serial.print("BLE chunked notify skipped (missing characteristic): ");
    Serial.println(payload);
    return;
  }

  if (!connected) {
    Serial.print("BLE chunked notify skipped (runtime client disconnected): ");
    Serial.println(payload);
    return;
  }

  Serial.print("BLE chunked notify sent: ");
  Serial.println(payload);
  characteristic->setValue(("BEGIN:" + String(payload.length())).c_str());
  characteristic->notify();
  delay(30);

  for (size_t offset = 0; offset < payload.length(); offset += STATUS_CHUNK_SIZE) {
    const String chunk = payload.substring(offset, offset + STATUS_CHUNK_SIZE);
    characteristic->setValue(chunk.c_str());
    characteristic->notify();
    delay(30);
  }

  characteristic->setValue("END");
  characteristic->notify();
  delay(30);
}

void sendProvisioningStatus(const String& payload) {
  notifyCharacteristic(provisioningStatusCharacteristic, provisioningBleConnected, payload);
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
  notifyCharacteristicChunked(runtimeStatusCharacteristic, runtimeBleConnected, payload);
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
  notifyCharacteristicChunked(runtimeStatusCharacteristic, runtimeBleConnected, payload);
}

void logRuntimeTransportEvent(const String& message) {
  Serial.print("[runtime] ");
  Serial.println(message);
}

void configureRuntimeAdvertisingPayload(BLEAdvertising* advertising) {
  if (advertising == nullptr) {
    return;
  }

  advertising->stop();
  advertising->setScanResponse(true);

  BLEAdvertisementData advertisementData;
  advertisementData.setFlags(ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT);
  advertisementData.setName(createBleDeviceName().c_str());
  advertisementData.setCompleteServices(BLEUUID(PROVISIONING_SERVICE_UUID));
  advertising->setAdvertisementData(advertisementData);

  BLEAdvertisementData scanResponseData;
  scanResponseData.setPartialServices(BLEUUID(RUNTIME_SERVICE_UUID));
  advertising->setScanResponseData(scanResponseData);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
}

void startRuntimeAdvertising(const String& reason) {
  if (bleServer == nullptr) {
    return;
  }

  BLEAdvertising* advertising = bleServer->getAdvertising();

  if (advertising == nullptr) {
    return;
  }

  configureRuntimeAdvertisingPayload(advertising);
  advertising->start();
  lastDisconnectedAdvertisingLogAt = millis();
  logRuntimeTransportEvent(
    "Advertising for Windows app reconnect (" + reason + ") as " +
    createBleDeviceName() + " with runtime scan response."
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

    if (bleServer != nullptr && runtimeBleConnIdKnown) {
      bleServer->disconnect(runtimeBleConnId);
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

    if (bleServer != nullptr && runtimeBleConnIdKnown) {
      bleServer->disconnect(runtimeBleConnId);
      return;
    }

    startRuntimeAdvertising("missing app-session lease");
    return;
  }

  logRuntimeLeaseState("Lease expiry timeout fired.", now);
  noteRuntimeAppSessionExpired(now);

  if (bleServer != nullptr && runtimeBleConnIdKnown) {
    bleServer->disconnect(runtimeBleConnId);
    return;
  }

  startRuntimeAdvertising("expired app-session lease");
}

void sendTelemetry(int delta, unsigned long timestamp, bool force) {
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
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}";

  notifyCharacteristic(runtimeTelemetryCharacteristic, runtimeBleConnected, payload);
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
      APP_SESSION_LEASE_DEFAULT_MS,
      HISTORY_SYNC_PAGE_SIZE
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
    sendTelemetry(lastReportedDelta, millis(), true);
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

  if (command.type == firmware_runtime::ControlCommandType::HistorySyncBegin) {
    disarmRuntimeBootstrapWatchdog();
    const firmware_runtime::HistorySyncRequest request =
      firmware_runtime::createHistorySyncRequest(command, HISTORY_SYNC_PAGE_SIZE);
    streamHistoryRecords(request.afterSequence, request.maxRecords);
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::HistoryAck) {
    disarmRuntimeBootstrapWatchdog();
    acknowledgeHistoryThrough(command.sequence);
    return;
  }
}

class GymServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    (void)server;
  }

  void onConnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
    provisioningBleConnected = true;
    runtimeBleConnected = true;
    runtimeBleConnectedAt = millis();
    lastDisconnectedAdvertisingLogAt = 0;
    lastConnectedRuntimeDebugAt = 0;
    runtimeBleConnIdKnown = param != nullptr;
    runtimeBleConnId = param != nullptr ? param->connect.conn_id : 0;
    resetRuntimeAppSessionState();
    armRuntimeBootstrapWatchdog(
      "BLE client connected; waiting for runtime or provisioning traffic."
    );
    sendProvisioningReady();
    if (runtimeStatusCharacteristic != nullptr) {
      runtimeStatusCharacteristic->setValue(createRuntimeReadyPayload().c_str());
    }
    sendTelemetry(lastReportedDelta, millis(), true);
  }

  void onDisconnect(BLEServer* server) override {
    (void)server;
  }

  void onDisconnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
    (void)param;
    provisioningBleConnected = false;
    runtimeBleConnected = false;
    runtimeBleConnectedAt = 0;
    lastConnectedRuntimeDebugAt = 0;
    noteRuntimeTransportDisconnected(millis());
    startRuntimeAdvertising("BLE client disconnected");
  }
};

class ProvisioningControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value(characteristic->getValue().c_str());

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
};

class ProvisioningStatusDescriptorCallbacks : public BLEDescriptorCallbacks {
  void onWrite(BLEDescriptor* descriptor) override {
    if (descriptor == nullptr) {
      return;
    }

    const uint8_t* value = descriptor->getValue();
    const size_t length = descriptor->getLength();
    const bool notificationsEnabled =
      value != nullptr && length > 0 && (value[0] & 0x01) != 0;

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
};

class RuntimeControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String value(characteristic->getValue().c_str());

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
};

class RuntimeTelemetryCallbacks : public BLECharacteristicCallbacks {
#if defined(CONFIG_NIMBLE_ENABLED)
  void onSubscribe(
    BLECharacteristic* characteristic,
    ble_gap_conn_desc* desc,
    uint16_t subValue
  ) override {
    (void)characteristic;
    (void)desc;

    if (subValue == 0) {
      return;
    }

    if (runtimeLeaseRequired || runtimeBootstrapLeasePending) {
      return;
    }

    armRuntimeBootstrapWatchdog(
      "Runtime telemetry subscribed; waiting for runtime control traffic."
    );
  }
#endif
};

class RuntimeTelemetryDescriptorCallbacks : public BLEDescriptorCallbacks {
  void onWrite(BLEDescriptor* descriptor) override {
    if (descriptor == nullptr) {
      return;
    }

    const uint8_t* value = descriptor->getValue();
    const size_t length = descriptor->getLength();
    const bool notificationsEnabled =
      value != nullptr && length > 0 && (value[0] & 0x01) != 0;

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
};

class RuntimeOtaDataCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const auto rawValue = characteristic->getValue();
    const std::string value(rawValue.c_str(), rawValue.length());
    handleOtaDataWrite(value);
  }
};

void setupBle() {
  BLEDevice::init(createBleDeviceName().c_str());
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new GymServerCallbacks());

  BLEService* provisioningService = bleServer->createService(PROVISIONING_SERVICE_UUID);
  provisioningControlCharacteristic = provisioningService->createCharacteristic(
    PROVISIONING_CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  provisioningStatusCharacteristic = provisioningService->createCharacteristic(
    PROVISIONING_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  provisioningControlCharacteristic->setCallbacks(new ProvisioningControlCallbacks());
  provisioningStatusDescriptor = new BLE2902();
  provisioningStatusDescriptor->setCallbacks(new ProvisioningStatusDescriptorCallbacks());
  provisioningStatusCharacteristic->addDescriptor(provisioningStatusDescriptor);
  provisioningStatusCharacteristic->setValue(createProvisioningReadyPayload().c_str());
  provisioningService->start();

  BLEService* runtimeService = bleServer->createService(RUNTIME_SERVICE_UUID);
  runtimeTelemetryCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_TELEMETRY_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  runtimeControlCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_CONTROL_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  runtimeStatusCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  runtimeOtaDataCharacteristic = runtimeService->createCharacteristic(
    RUNTIME_OTA_DATA_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );

  runtimeTelemetryDescriptor = new BLE2902();
  runtimeTelemetryDescriptor->setCallbacks(new RuntimeTelemetryDescriptorCallbacks());
  runtimeTelemetryCharacteristic->addDescriptor(runtimeTelemetryDescriptor);
  runtimeStatusCharacteristic->addDescriptor(new BLE2902());
  runtimeTelemetryCharacteristic->setCallbacks(new RuntimeTelemetryCallbacks());
  runtimeControlCharacteristic->setCallbacks(new RuntimeControlCallbacks());
  runtimeOtaDataCharacteristic->setCallbacks(new RuntimeOtaDataCallbacks());
  runtimeStatusCharacteristic->setValue(createRuntimeReadyPayload().c_str());
  runtimeService->start();

  BLEAdvertising* advertising = bleServer->getAdvertising();
  configureRuntimeAdvertisingPayload(advertising);
  advertising->start();
  lastDisconnectedAdvertisingLogAt = millis();
  logRuntimeTransportEvent(
    "BLE advertising started as " + createBleDeviceName() +
    " with runtime scan response."
  );
}
