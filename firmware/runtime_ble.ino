BLEService provisioningService{BLEUuid(PROVISIONING_SERVICE_UUID)};
BLEService runtimeService{BLEUuid(RUNTIME_SERVICE_UUID)};
BLEService historyService{BLEUuid(HISTORY_SERVICE_UUID)};
BLEDfu dfuService;

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
    if (data[index] == '\0') {
      continue;
    }
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

bool notifyCharacteristicValueForConnection(
  BLECharacteristic* characteristic,
  uint16_t conn_hdl,
  const String& payload
) {
  if (characteristic == nullptr) {
    return false;
  }

  characteristic->write(payload.c_str());

  if (!characteristic->notifyEnabled(conn_hdl)) {
    return true;
  }

  return characteristic->notify(conn_hdl, payload.c_str());
}

void notifyProvisioningCharacteristic(BLECharacteristic* characteristic, const String& payload) {
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
}

void notifyRuntimeCharacteristic(BLECharacteristic* characteristic, const String& payload) {
  if (characteristic == nullptr) {
    Serial.print("BLE notify skipped (missing runtime characteristic): ");
    Serial.println(payload);
    return;
  }

  if (!runtimeBleConnected) {
    Serial.print("BLE notify skipped (runtime client disconnected): ");
    Serial.println(payload);
    return;
  }

  Serial.print("BLE notify sent: ");
  Serial.println(payload);
  notifyCharacteristicValue(characteristic, payload);
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

size_t bleTxQueueFreeSlots(const BleTxQueue& queue) {
  return BLE_TX_QUEUE_CAPACITY - queue.length;
}

size_t chunkedNotificationSlotCount(size_t payloadLength) {
  const size_t chunkCount =
    payloadLength == 0 ? 0 : ((payloadLength + STATUS_CHUNK_SIZE - 1) / STATUS_CHUNK_SIZE);
  return chunkCount + 2;  // BEGIN + payload chunks + END
}

void rollbackBleTxMessageEnqueue(BleTxQueue& queue, size_t count) {
  while (count > 0 && queue.length > 0) {
    queue.tail = (queue.tail + BLE_TX_QUEUE_CAPACITY - 1) % BLE_TX_QUEUE_CAPACITY;
    queue.entries[queue.tail] = BleTxMessage();
    queue.length -= 1;
    count -= 1;
  }
}

bool enqueueChunkedNotification(
  BleTxQueue& queue,
  BLECharacteristic* characteristic,
  bool* connectedFlag,
  const String& payload
) {
  const size_t requiredSlots = chunkedNotificationSlotCount(payload.length());
  if (bleTxQueueFreeSlots(queue) < requiredSlots) {
    Serial.print("BLE queue dropped (insufficient frame space): ");
    Serial.println(payload);
    return false;
  }

  size_t enqueuedCount = 0;
  for (size_t offset = 0; offset < payload.length(); offset += STATUS_CHUNK_SIZE) {
    if (offset == 0) {
      if (!enqueueBleTxMessage(queue, characteristic, connectedFlag, "BEGIN:" + String(payload.length()))) {
        rollbackBleTxMessageEnqueue(queue, enqueuedCount);
        return false;
      }
      enqueuedCount += 1;
    }

    if (!enqueueBleTxMessage(
          queue,
          characteristic,
          connectedFlag,
          payload.substring(offset, offset + STATUS_CHUNK_SIZE)
        )) {
      rollbackBleTxMessageEnqueue(queue, enqueuedCount);
      return false;
    }
    enqueuedCount += 1;
  }

  if (payload.length() == 0) {
    if (!enqueueBleTxMessage(queue, characteristic, connectedFlag, "BEGIN:0")) {
      rollbackBleTxMessageEnqueue(queue, enqueuedCount);
      return false;
    }
    enqueuedCount += 1;
  }

  if (!enqueueBleTxMessage(queue, characteristic, connectedFlag, "END")) {
    rollbackBleTxMessageEnqueue(queue, enqueuedCount);
    return false;
  }

  return true;
}

bool enqueueRuntimeNotification(BLECharacteristic* characteristic, const String& payload) {
  return enqueueBleTxMessage(runtimeTxQueue, characteristic, &runtimeBleConnected, payload);
}

bool enqueueRuntimeNotificationChunked(BLECharacteristic* characteristic, const String& payload) {
  return enqueueChunkedNotification(runtimeTxQueue, characteristic, &runtimeBleConnected, payload);
}

bool enqueueRuntimeStatusPayload(const String& payload) {
  if (payload.length() <= 244) {
    return enqueueRuntimeNotification(runtimeStatusCharacteristic, payload);
  }

  return enqueueRuntimeNotificationChunked(runtimeStatusCharacteristic, payload);
}

bool enqueueHistoryNotification(BLECharacteristic* characteristic, const String& payload) {
  return enqueueBleTxMessage(historyTxQueue, characteristic, &runtimeBleConnected, payload);
}

bool enqueueHistoryNotificationChunked(BLECharacteristic* characteristic, const String& payload) {
  return enqueueChunkedNotification(historyTxQueue, characteristic, &runtimeBleConnected, payload);
}

bool enqueueHistoryStatusPayload(const String& payload) {
  if (payload.length() <= 244) {
    return enqueueHistoryNotification(historyStatusCharacteristic, payload);
  }

  return enqueueHistoryNotificationChunked(historyStatusCharacteristic, payload);
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
  notifyProvisioningCharacteristic(provisioningStatusCharacteristic, payload);
}

String createRuntimeReadyPayload() {
  return
    "{\"type\":\"ready\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"bootUptimeMs\":" + String(millis()) +
    ",\"notifyMask\":" + String(runtimeNotifyMask) +
    ",\"rcw\":" + String(runtimeControlWriteCount) +
    ",\"hcw\":" + String(historyControlWriteCount) +
    ",\"connectionEpoch\":" + String(runtimeConnectionEpoch) +
    ",\"disconnectCount\":" + String(runtimeDisconnectCount) + "}";
}

String createProvisioningReadyPayload() {
  return
    "{\"type\":\"ready\",\"hardwareId\":\"" + escapeJsonString(hardwareId) +
    "\",\"firmwareVersion\":\"" + firmwareVersionString() +
    "\",\"deviceName\":\"" + escapeJsonString(createBleDeviceName()) + "\"}";
}

void sendProvisioningReady() {
  sendProvisioningStatus(createProvisioningReadyPayload());
}

void sendRuntimeAppSessionOnline(
  const String& sessionId,
  const String& sessionNonce,
  int32_t notifyConnHandle = -1
);

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

void enqueueBoardLogStatus(const String& tag, const String& message, const String& level) {
  (void)tag;
  (void)message;
  (void)level;
}

void sendHistoryDebugStatus(
  const String& stage,
  const String& requestId,
  unsigned long afterSequence,
  size_t sentCount,
  const String& code,
  const String& message
) {
  String payload =
    "{\"type\":\"history-debug\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"stage\":\"" + escapeJsonString(stage) +
    "\",\"requestId\":\"" + escapeJsonString(requestId) + "\"";

  if (afterSequence > 0) {
    payload += ",\"afterSequence\":" + String(afterSequence);
  }

  if (sentCount > 0) {
    payload += ",\"sentCount\":" + String(sentCount);
  }

  if (code.length() > 0) {
    payload += ",\"code\":\"" + escapeJsonString(code) + "\"";
  }

  if (message.length() > 0) {
    payload += ",\"message\":\"" + escapeJsonString(message) + "\"";
  }

  payload += "}";
  writeCharacteristicValue(historyStatusCharacteristic, payload);
  enqueueHistoryStatusPayload(payload);
  if (runtimeStatusCharacteristic != nullptr) {
    writeCharacteristicValue(runtimeStatusCharacteristic, payload);
    enqueueRuntimeStatusPayload(payload);
  }
}

void notePendingHistoryControlDebug(
  const String& stage,
  const String& requestId,
  unsigned long afterSequence
) {
  pendingHistoryControlDebugStage = stage;
  pendingHistoryControlDebugRequestId = requestId;
  pendingHistoryControlDebugAfterSequence = afterSequence;
  pendingHistoryControlDebugPublish = true;
}

void publishPendingHistoryControlDebug() {
  if (!pendingHistoryControlDebugPublish) {
    return;
  }

  String payload =
    "{\"type\":\"history-debug\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"stage\":\"" + escapeJsonString(pendingHistoryControlDebugStage) +
    "\",\"requestId\":\"" + escapeJsonString(pendingHistoryControlDebugRequestId) + "\"";

  if (pendingHistoryControlDebugAfterSequence > 0) {
    payload += ",\"afterSequence\":" + String(pendingHistoryControlDebugAfterSequence);
  }

  payload += "}";

  pendingHistoryControlDebugPublish = false;
  if (payload == publishedHistoryControlDebugPayload) {
    return;
  }

  publishedHistoryControlDebugPayload = payload;
  enqueueRuntimeStatusPayload(payload);
}

void notifyCurrentRuntimeStatus() {
  if (runtimeAppSessionConnected &&
      runtimeAppSessionId.length() > 0 &&
      runtimeAppSessionNonce.length() > 0) {
    sendRuntimeAppSessionOnline(runtimeAppSessionId, runtimeAppSessionNonce);
    return;
  }

  notifyRuntimeCharacteristic(runtimeStatusCharacteristic, createRuntimeReadyPayload());
}

void writeCurrentStatusSnapshots() {
  if (runtimeStatusCharacteristic != nullptr) {
    if (runtimeAppSessionConnected &&
        runtimeAppSessionId.length() > 0 &&
        runtimeAppSessionNonce.length() > 0) {
      writeCharacteristicValue(
        runtimeStatusCharacteristic,
        createRuntimeAppSessionOnlinePayload(runtimeAppSessionId, runtimeAppSessionNonce)
      );
    } else {
      writeCharacteristicValue(runtimeStatusCharacteristic, createRuntimeReadyPayload());
    }
  }

  if (historyStatusCharacteristic != nullptr) {
    writeCharacteristicValue(historyStatusCharacteristic, createRuntimeReadyPayload());
  }
}

String createRuntimeAppSessionOnlinePayload(
  const String& sessionId,
  const String& sessionNonce
) {
  return
    "{\"type\":\"app-session-online\",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"sessionId\":\"" + escapeJsonString(sessionId) +
    "\",\"sessionNonce\":\"" + escapeJsonString(sessionNonce) +
    "\",\"bootUptimeMs\":" + String(millis()) +
    ",\"notifyMask\":" + String(runtimeNotifyMask) +
    ",\"rcw\":" + String(runtimeControlWriteCount) +
    ",\"hcw\":" + String(historyControlWriteCount) + "}";
}

void sendRuntimeAppSessionOnline(
  const String& sessionId,
  const String& sessionNonce,
  int32_t notifyConnHandle
) {
  (void)notifyConnHandle;
  String payload = createRuntimeAppSessionOnlinePayload(sessionId, sessionNonce);
  writeCharacteristicValue(runtimeStatusCharacteristic, payload);
  enqueueRuntimeStatusPayload(payload);
}

void logRuntimeTransportEvent(const String& message) {
  (void)message;
}

void logRuntimeControlFrame(const String& stage, const String& payload) {
  Serial.print("[runtime-control] ");
  Serial.print(stage);
  Serial.print(": ");
  Serial.println(payload);
}

void logRuntimeHistoryEvent(const String& message) {
  Serial.print("[history] ");
  Serial.println(message);
  enqueueBoardLogStatus("history", message);
}

bool isHistoryControlPayload(const String& payload) {
  return payload.indexOf("\"history-page-request\"") >= 0 ||
         payload.indexOf("\"history-page-ack\"") >= 0;
}

String classifyRuntimeControlPayloadType(const String& payload) {
  if (payload.indexOf("\"app-session-begin\"") >= 0) {
    return "app-session-begin";
  }

  if (payload.indexOf("\"app-session-lease\"") >= 0) {
    return "app-session-lease";
  }

  if (payload.indexOf("\"sync-now\"") >= 0) {
    return "sync-now";
  }

  if (payload.indexOf("\"history-page-request\"") >= 0) {
    return "history-page-request";
  }

  if (payload.indexOf("\"history-page-ack\"") >= 0) {
    return "history-page-ack";
  }

  return "";
}

void sendRuntimeControlDebugStatus(const String& stage, const String& controlType) {
  if (runtimeStatusCharacteristic == nullptr) {
    return;
  }

  String payload =
    "{\"type\":\"runtime-control-debug\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"stage\":\"" + escapeJsonString(stage) + "\"";

  if (controlType.length() > 0) {
    payload += ",\"controlType\":\"" + escapeJsonString(controlType) + "\"";
  }

  payload += "}";
  writeCharacteristicValue(runtimeStatusCharacteristic, payload);
  enqueueRuntimeStatusPayload(payload);
}

String historyControlRequestIdFromPayload(const String& payload) {
  return extractJsonString(payload, "requestId");
}

void logAdvertisingSetupFailure(const char* field) {
  markNodeBleFailure();
  Serial.print("BLE advertising payload setup failed: ");
  Serial.println(field);
}

bool addRuntimeAdvertisingSessionData() {
  static constexpr uint16_t kGymMotionManufacturerId = 0xFFFF;
  uint8_t payload[10] = {
    static_cast<uint8_t>(kGymMotionManufacturerId & 0xFF),
    static_cast<uint8_t>((kGymMotionManufacturerId >> 8) & 0xFF),
    'G',
    'M',
    0x01,
    static_cast<uint8_t>(runtimeAppSessionConnected && runtimeAppSessionId.length() == 8 ? 0x01 : 0x00),
    0,
    0,
    0,
    0
  };

  if (runtimeAppSessionConnected && runtimeAppSessionId.length() == 8) {
    for (int index = 0; index < 4; index++) {
      const String byteHex = runtimeAppSessionId.substring(index * 2, index * 2 + 2);
      payload[6 + index] = static_cast<uint8_t>(strtoul(byteHex.c_str(), nullptr, 16));
    }
  }

  return Bluefruit.Advertising.addManufacturerData(payload, sizeof(payload));
}

void configureRuntimeAdvertisingPayload() {
  Bluefruit.Advertising.stop();
  Bluefruit.Advertising.clearData();
  Bluefruit.ScanResponse.clearData();
  Bluefruit.setName(createBleDeviceName().c_str());

  if (!Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE)) {
    logAdvertisingSetupFailure("flags");
  }

  if (!addRuntimeAdvertisingSessionData()) {
    logAdvertisingSetupFailure("manufacturer session data");
  }

  if (!Bluefruit.ScanResponse.addName()) {
    logAdvertisingSetupFailure("scan response name");
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
  if (!Bluefruit.Advertising.start(0)) {
    markNodeBleFailure();
    logRuntimeTransportEvent("BLE advertising failed to start.");
    return;
  }

  markNodeAdvertising();
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
  runtimeAppSessionId = state.runtimeAppSessionId.c_str();
  runtimeAppSessionNonce = state.runtimeAppSessionNonce.c_str();
  lastAppSessionLeaseAt = state.lastAppSessionLeaseAt;
  lastRuntimeControlAt = state.lastRuntimeControlAt;
  appSessionLeaseTimeoutMs = state.appSessionLeaseTimeoutMs;
  resetRuntimeTransportBuffers();
  if (runtimeStatusCharacteristic != nullptr) {
    writeCharacteristicValue(runtimeStatusCharacteristic, createRuntimeReadyPayload());
  }
  if (historyStatusCharacteristic != nullptr) {
    writeCharacteristicValue(historyStatusCharacteristic, createRuntimeReadyPayload());
  }
}

void resetRuntimeTransportBuffers() {
  runtimeCommandBuffer = "";
  historyCommandBuffer = "";
  runtimeCommandFramed = false;
  historyCommandFramed = false;
  runtimeHistoryChunkDirectNotified = false;
  pendingHistoryControlDebugPublish = false;
  pendingHistoryControlDebugStage = "";
  pendingHistoryControlDebugRequestId = "";
  pendingHistoryControlDebugAfterSequence = 0;
  publishedHistoryControlDebugPayload = "";
  pendingHistorySyncCommand = firmware_runtime::HistoryControlCommand();
  pendingHistorySyncRequest = false;
  cancelHistoryWorker();
  lastCompletedHistoryRequestId = "";
  lastAutoHistoryDecisionMessage = "";
}

void armRuntimeBootstrapWatchdog(const String& message) {
  firmware_runtime::AppSessionState state;
  state.runtimeBleConnected = runtimeBleConnected;
  state.runtimeAppSessionConnected = runtimeAppSessionConnected;
  state.runtimeBootstrapLeasePending = runtimeBootstrapLeasePending;

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
  unsigned long timestamp,
  bool forceStatusEmit = false,
  int32_t notifyConnHandle = -1
) {
  disarmRuntimeBootstrapWatchdog();

  firmware_runtime::AppSessionState state;
  state.runtimeAppSessionConnected = runtimeAppSessionConnected;
  state.runtimeAppSessionId = runtimeAppSessionId.c_str();
  state.runtimeAppSessionNonce = runtimeAppSessionNonce.c_str();
  state.lastAppSessionLeaseAt = lastAppSessionLeaseAt;
  state.lastRuntimeControlAt = lastRuntimeControlAt;
  state.appSessionLeaseTimeoutMs = appSessionLeaseTimeoutMs;

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
  runtimeBootstrapLeasePending = state.runtimeBootstrapLeasePending;

  if (!update.sessionChanged && !forceStatusEmit) {
    logRuntimeLeaseState("Lease refreshed.", timestamp);
    return;
  }

  if (update.sessionChanged) {
    logRuntimeTransportEvent(
      "Windows app session lease is active for session " + sessionId + "."
    );
  } else {
    logRuntimeTransportEvent(
      "Re-sending Windows app session online ack for session " + sessionId + "."
    );
  }
  sendRuntimeAppSessionOnline(sessionId, sessionNonce, notifyConnHandle);

  (void)timestamp;
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

  (void)timestamp;
}

void noteRuntimeTransportDisconnected(unsigned long timestamp) {
  const bool hadSession = runtimeAppSessionConnected || runtimeAppSessionId.length() > 0;
  runtimeDisconnectCount += 1;
  runtimeBleConnIdKnown = false;
  runtimeBleConnId = 0;

  logRuntimeTransportEvent(
    hadSession
      ? "BLE runtime transport disconnected from the Windows app; keeping the app session alive until the lease expires."
      : "BLE runtime transport disconnected from the Windows app."
  );

  if (!hadSession) {
    return;
  }

  (void)timestamp;
}

void enforceRuntimeAppSessionLease() {
  const unsigned long now = millis();
  firmware_runtime::AppSessionState state;
  state.runtimeBleConnected = runtimeBleConnected;
  state.runtimeAppSessionConnected = runtimeAppSessionConnected;
  state.runtimeBootstrapLeasePending = runtimeBootstrapLeasePending;
  state.runtimeBleConnectedAt = runtimeBleConnectedAt;
  state.lastAppSessionLeaseAt = lastAppSessionLeaseAt;
  state.lastRuntimeControlAt = lastRuntimeControlAt;
  state.appSessionLeaseTimeoutMs = appSessionLeaseTimeoutMs;
  state.runtimeAppSessionId = runtimeAppSessionId.c_str();
  state.runtimeAppSessionNonce = runtimeAppSessionNonce.c_str();

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

  writeCharacteristicValue(runtimeTelemetryCharacteristic, payload);
  enqueueRuntimeNotification(runtimeTelemetryCharacteristic, payload);
  lastReportedState = currentDetectedState;
  lastReportedDelta = delta;
  lastTelemetryAt = timestamp;
  pendingMotionUpdate = false;
}

void handleProvisioningCommand(const String& payload) {
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

void handleRuntimeControl(const String& payload, int32_t notifyConnHandle = -1) {
  logRuntimeControlFrame("payload", payload);
  const bool historyPayload = isHistoryControlPayload(payload);
  const String historyRequestId = historyControlRequestIdFromPayload(payload);
  const firmware_runtime::ControlCommand command =
    firmware_runtime::parseRuntimeControlCommand(
      payload.c_str(),
      APP_SESSION_LEASE_DEFAULT_MS
    );
  lastRuntimeControlAt = millis();

  if (command.type == firmware_runtime::ControlCommandType::AppSessionBegin) {
    disarmRuntimeBootstrapWatchdog();
    const String sessionId = command.sessionId.c_str();
    const String sessionNonce = command.sessionNonce.c_str();
    const unsigned long expiresInMs = command.expiresInMs;

    if (sessionId.length() == 0 || sessionNonce.length() == 0) {
      return;
    }

    logRuntimeTransportEvent(
      "Applying app-session-begin for session " + sessionId +
      " (previous=" + (runtimeAppSessionId.length() > 0 ? runtimeAppSessionId : "(none)") + ")."
    );
    markRuntimeAppSessionOnline(
      sessionId,
      sessionNonce,
      expiresInMs,
      millis(),
      true,
      notifyConnHandle
    );
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::AppSessionLease) {
    const String sessionId = command.sessionId.c_str();
    const unsigned long expiresInMs = command.expiresInMs;

    if (sessionId.length() == 0) {
      return;
    }

    if (!runtimeAppSessionConnected ||
        runtimeAppSessionId.length() == 0 ||
        runtimeAppSessionNonce.length() == 0) {
      return;
    }

    const bool shortReconnectToken = sessionId.length() == 8;
    const bool sessionMatches = shortReconnectToken
      ? runtimeAppSessionId.startsWith(sessionId)
      : runtimeAppSessionId == sessionId;

    if (!sessionMatches) {
      logRuntimeTransportEvent(
        "Rejected app-session-lease for session " + sessionId +
        " because active session is " +
        (runtimeAppSessionId.length() > 0 ? runtimeAppSessionId : "(none)") + "."
      );
      return;
    }

    markRuntimeAppSessionOnline(
      runtimeAppSessionId,
      runtimeAppSessionNonce,
      expiresInMs,
      millis(),
      false,
      notifyConnHandle
    );
    return;
  }

  if (command.type == firmware_runtime::ControlCommandType::AppSessionEnd) {
    const String sessionId = command.sessionId.c_str();
    const bool shortReconnectToken = sessionId.length() == 8;
    const bool sessionMatches =
      sessionId.length() == 0 ||
      (shortReconnectToken
        ? runtimeAppSessionId.startsWith(sessionId)
        : runtimeAppSessionId == sessionId);

    if (!runtimeAppSessionConnected ||
        runtimeAppSessionId.length() == 0 ||
        !sessionMatches) {
      return;
    }
    logRuntimeTransportEvent(
      "Windows app requested runtime session teardown; disconnecting BLE transport."
    );
    resetRuntimeAppSessionState();

    if (runtimeBleConnIdKnown) {
      Bluefruit.disconnect(runtimeBleConnId);
      return;
    }

    startRuntimeAdvertising("requested app-session end");
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

  const firmware_runtime::HistoryControlCommand historyCommand =
    firmware_runtime::parseHistoryControlCommand(
      payload.c_str(),
      HISTORY_SYNC_PAGE_SIZE
    );

  if (historyCommand.type == firmware_runtime::HistoryControlCommandType::HistoryPageRequest) {
    disarmRuntimeBootstrapWatchdog();
    notePendingHistoryControlDebug(
      "parsed-request",
      historyCommand.requestId.c_str(),
      historyCommand.afterSequence
    );
    sendHistoryDebugStatus(
      "parsed-request",
      historyCommand.requestId.c_str(),
      historyCommand.afterSequence,
      0,
      "",
      ""
    );
    scheduleHistorySyncRequest(historyCommand);
    return;
  }

  if (historyCommand.type == firmware_runtime::HistoryControlCommandType::HistoryPageAck) {
    disarmRuntimeBootstrapWatchdog();
    notePendingHistoryControlDebug(
      "parsed-ack",
      historyCommand.requestId.c_str(),
      historyCommand.sequence
    );
    sendHistoryDebugStatus(
      "parsed-ack",
      historyCommand.requestId.c_str(),
      historyCommand.sequence,
      0,
      "",
      ""
    );
    acknowledgeHistorySyncRequest(historyCommand);
    return;
  }

  if (historyPayload) {
    notePendingHistoryControlDebug(
      "invalid-control",
      historyRequestId,
      0
    );
    sendHistoryDebugStatus(
      "invalid-control",
      historyRequestId,
      0,
      0,
      "history.invalid_control",
      "Runtime control payload mentioned history sync but did not parse."
    );
  }
}

void handleHistoryControl(const String& payload) {
  const firmware_runtime::HistoryControlCommand command =
    firmware_runtime::parseHistoryControlCommand(
      payload.c_str(),
      HISTORY_SYNC_PAGE_SIZE
    );

  if (command.type == firmware_runtime::HistoryControlCommandType::Unknown) {
    enqueueBoardLogStatus(
      "history-control",
      "History control payload did not parse into a supported command.",
      "warn"
    );
    sendHistoryError("", "", "history.invalid_command", "Unsupported history control command.");
    return;
  }

  disarmRuntimeBootstrapWatchdog();
  lastRuntimeControlAt = millis();

  if (command.type == firmware_runtime::HistoryControlCommandType::HistoryPageRequest) {
    const String requestId = String(command.requestId.c_str());
    enqueueBoardLogStatus(
      "history-control",
      "Accepted history-page-request " + requestId + " after=" +
        String(command.afterSequence) + " max=" + String(command.maxRecords)
    );
    scheduleHistorySyncRequest(command);
    return;
  }

  if (command.type == firmware_runtime::HistoryControlCommandType::HistoryPageAck) {
    const String requestId = String(command.requestId.c_str());
    enqueueBoardLogStatus(
      "history-control",
      "Accepted history-page-ack " + requestId + " sequence=" +
        String(command.sequence)
    );
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

  if (value.startsWith("BEGIN:")) {
    provisioningCommandBuffer = "";
    provisioningCommandFramed = true;
    return;
  }

  if (provisioningCommandFramed && value == "END") {
    const String command = provisioningCommandBuffer;
    provisioningCommandBuffer = "";
    provisioningCommandFramed = false;
    handleProvisioningCommand(command);
    return;
  }

  if (provisioningCommandFramed) {
    provisioningCommandBuffer += value;
    return;
  }

  if (value.startsWith("{") && value.endsWith("}")) {
    handleProvisioningCommand(value);
    return;
  }

  provisioningCommandBuffer = "";
  provisioningCommandBuffer += value;
}

void handleRuntimeControlWrite(uint16_t conn_hdl, BLECharacteristic* characteristic, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)characteristic;
  const String value = bytesToString(data, len);
  const String controlType = classifyRuntimeControlPayloadType(value);

  if (value.length() == 0) {
    return;
  }

  runtimeControlWriteCount += 1;
  writeCurrentStatusSnapshots();

  if (controlType.length() > 0) {
    sendRuntimeControlDebugStatus("write-callback", controlType);
  }

  if (value.startsWith("BEGIN:")) {
    sendRuntimeControlDebugStatus("frame-begin", "");
    notePendingHistoryControlDebug("runtime-begin", "", 0);
    runtimeCommandBuffer = "";
    runtimeCommandFramed = true;
    runtimeHistoryChunkDirectNotified = false;
    logRuntimeControlFrame("begin", value);
    return;
  }

  if (runtimeCommandFramed && value == "END") {
    const String command = runtimeCommandBuffer;
    const String framedControlType = classifyRuntimeControlPayloadType(command);
    notePendingHistoryControlDebug("runtime-end", framedControlType, 0);
    runtimeCommandBuffer = "";
    runtimeCommandFramed = false;
    logRuntimeControlFrame("end", command);
    if (framedControlType.length() > 0) {
      sendRuntimeControlDebugStatus("assembled-framed", framedControlType);
    }
    if (isHistoryControlPayload(command)) {
      notePendingHistoryControlDebug(
        "assembled-framed",
        historyControlRequestIdFromPayload(command),
        0
      );
      sendHistoryDebugStatus(
        "assembled-framed",
        historyControlRequestIdFromPayload(command),
        0,
        0,
        "",
        ""
      );
    }
    handleRuntimeControl(command, conn_hdl);
    return;
  }

  if (runtimeCommandFramed) {
    runtimeCommandBuffer += value;
    const String chunkedControlType = classifyRuntimeControlPayloadType(runtimeCommandBuffer);
    notePendingHistoryControlDebug("runtime-frame-chunk", chunkedControlType, 0);
    if (chunkedControlType.length() > 0) {
      sendRuntimeControlDebugStatus("frame-chunk", chunkedControlType);
    }
    if (!runtimeHistoryChunkDirectNotified &&
        runtimeCommandBuffer.indexOf("\"history-page-") >= 0) {
      runtimeHistoryChunkDirectNotified = true;
    }
    if (runtimeCommandBuffer.indexOf("\"history-page-") >= 0) {
      notePendingHistoryControlDebug(
        "runtime-chunk",
        historyControlRequestIdFromPayload(runtimeCommandBuffer),
        0
      );
    }
    logRuntimeControlFrame("chunk", value);
    return;
  }

  if (value.startsWith("{") && value.endsWith("}")) {
    notePendingHistoryControlDebug("runtime-inline", controlType, 0);
    if (controlType.length() > 0) {
      sendRuntimeControlDebugStatus("assembled-inline", controlType);
    }
    if (isHistoryControlPayload(value)) {
      notePendingHistoryControlDebug(
        "assembled-inline",
        historyControlRequestIdFromPayload(value),
        0
      );
      sendHistoryDebugStatus(
        "assembled-inline",
        historyControlRequestIdFromPayload(value),
        0,
        0,
        "",
        ""
      );
    }
    handleRuntimeControl(value, conn_hdl);
    return;
  }

  runtimeCommandBuffer = "";
  runtimeCommandBuffer += value;
  logRuntimeControlFrame("chunk", value);
}

void handleHistoryControlWrite(uint16_t conn_hdl, BLECharacteristic* characteristic, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)characteristic;
  const String value = bytesToString(data, len);

  if (value.length() == 0) {
    return;
  }

  historyControlWriteCount += 1;
  writeCurrentStatusSnapshots();
  enqueueBoardLogStatus(
    "history-control",
    "History control write callback entered len=" + String(value.length())
  );

  if (value.startsWith("BEGIN:")) {
    notePendingHistoryControlDebug("history-begin", "", 0);
    historyCommandBuffer = "";
    historyCommandFramed = true;
    return;
  }

  if (historyCommandFramed && value == "END") {
    const String command = historyCommandBuffer;
    historyCommandBuffer = "";
    historyCommandFramed = false;
    if (isHistoryControlPayload(command)) {
      notePendingHistoryControlDebug(
        "history-assembled-framed",
        historyControlRequestIdFromPayload(command),
        0
      );
      sendHistoryDebugStatus(
        "history-assembled-framed",
        historyControlRequestIdFromPayload(command),
        0,
        0,
        "",
        ""
      );
    }
    handleHistoryControl(command);
    return;
  }

  if (historyCommandFramed) {
    historyCommandBuffer += value;
    if (historyCommandBuffer.indexOf("\"history-page-") >= 0) {
      notePendingHistoryControlDebug(
        "history-chunk",
        historyControlRequestIdFromPayload(historyCommandBuffer),
        0
      );
    }
    return;
  }

  if (value.startsWith("{") && value.endsWith("}")) {
    if (isHistoryControlPayload(value)) {
      notePendingHistoryControlDebug(
        "history-assembled-inline",
        historyControlRequestIdFromPayload(value),
        0
      );
      sendHistoryDebugStatus(
        "history-assembled-inline",
        historyControlRequestIdFromPayload(value),
        0,
        0,
        "",
        ""
      );
    }
    handleHistoryControl(value);
    return;
  }

  historyCommandBuffer = "";
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
  (void)cccd_value;
}

void handleRuntimeTelemetryCccd(uint16_t conn_hdl, BLECharacteristic* characteristic, uint16_t cccd_value) {
  ensureRuntimeConnectionInitialized(conn_hdl, "runtime telemetry cccd");
  (void)conn_hdl;
  (void)characteristic;
  if ((cccd_value & 0x0001) != 0) {
    runtimeNotifyMask |= RUNTIME_NOTIFY_MASK_TELEMETRY;
  } else {
    runtimeNotifyMask &= static_cast<uint8_t>(~RUNTIME_NOTIFY_MASK_TELEMETRY);
  }
}

void handleRuntimeStatusCccd(uint16_t conn_hdl, BLECharacteristic* characteristic, uint16_t cccd_value) {
  ensureRuntimeConnectionInitialized(conn_hdl, "runtime status cccd");
  const bool deliveryEnabled = (cccd_value & 0x0003) != 0;
  if (deliveryEnabled) {
    runtimeNotifyMask |= RUNTIME_NOTIFY_MASK_STATUS;
  } else {
    runtimeNotifyMask &= static_cast<uint8_t>(~RUNTIME_NOTIFY_MASK_STATUS);
  }
  if (!deliveryEnabled) {
    return;
  }

  if (runtimeAppSessionConnected &&
      runtimeAppSessionId.length() > 0 &&
      runtimeAppSessionNonce.length() > 0) {
    const String payload =
      createRuntimeAppSessionOnlinePayload(runtimeAppSessionId, runtimeAppSessionNonce);
    writeCharacteristicValue(characteristic, payload);
    enqueueRuntimeStatusPayload(payload);
    return;
  }

  const String payload = createRuntimeReadyPayload();
  writeCharacteristicValue(characteristic, payload);
  enqueueRuntimeStatusPayload(payload);
}

void handleHistoryStatusCccd(uint16_t conn_hdl, BLECharacteristic* characteristic, uint16_t cccd_value) {
  ensureRuntimeConnectionInitialized(conn_hdl, "history status cccd");
  const bool deliveryEnabled = (cccd_value & 0x0003) != 0;
  if (deliveryEnabled) {
    runtimeNotifyMask |= RUNTIME_NOTIFY_MASK_HISTORY;
  } else {
    runtimeNotifyMask &= static_cast<uint8_t>(~RUNTIME_NOTIFY_MASK_HISTORY);
  }

  writeCharacteristicValue(characteristic, createRuntimeReadyPayload());
  if (!deliveryEnabled) {
    return;
  }

  enqueueHistoryStatusPayload(createRuntimeReadyPayload());
}

void initializeRuntimeConnection(uint16_t conn_handle) {
  const bool hasActiveSession =
    runtimeAppSessionConnected &&
    runtimeAppSessionId.length() > 0 &&
    runtimeAppSessionNonce.length() > 0;
  markNodeConnected();
  runtimeConnectionEpoch += 1;
  provisioningBleConnected = true;
  runtimeBleConnected = true;
  runtimeBleConnectedAt = millis();
  lastDisconnectedAdvertisingLogAt = 0;
  lastConnectedRuntimeDebugAt = 0;
  runtimeBleConnIdKnown = true;
  runtimeBleConnId = conn_handle;
  runtimeNotifyMask = 0;
  resetRuntimeTransportBuffers();
  if (hasActiveSession) {
    disarmRuntimeBootstrapWatchdog();
  } else {
    armRuntimeBootstrapWatchdog(
      "BLE client connected; waiting for runtime or provisioning traffic."
    );
  }

  BLEConnection* connection = Bluefruit.Connection(conn_handle);
  if (connection != nullptr) {
    connection->requestPHY();
    connection->requestDataLengthUpdate();
    connection->requestMtuExchange(247);
  }

  sendProvisioningReady();
  if (hasActiveSession) {
    writeCharacteristicValue(
      runtimeStatusCharacteristic,
      createRuntimeAppSessionOnlinePayload(runtimeAppSessionId, runtimeAppSessionNonce)
    );
  } else {
    writeCharacteristicValue(runtimeStatusCharacteristic, createRuntimeReadyPayload());
  }
  writeCharacteristicValue(historyStatusCharacteristic, createRuntimeReadyPayload());
  sendTelemetry(lastReportedDelta, millis(), true, false);
}

void ensureRuntimeConnectionInitialized(uint16_t conn_handle, const char* source) {
  if (runtimeBleConnected &&
      runtimeBleConnIdKnown &&
      runtimeBleConnId == conn_handle) {
    return;
  }

  Serial.print("[runtime] recovering connection state from ");
  Serial.println(source);
  initializeRuntimeConnection(conn_handle);
}

void handleBleConnect(uint16_t conn_handle) {
  initializeRuntimeConnection(conn_handle);
}

void handleBleDisconnect(uint16_t conn_handle, uint8_t reason) {
  (void)conn_handle;
  (void)reason;
  markNodeAdvertising();
  provisioningBleConnected = false;
  runtimeBleConnected = false;
  runtimeBleConnectedAt = 0;
  lastConnectedRuntimeDebugAt = 0;
  runtimeNotifyMask = 0;
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

  dfuService.begin();
  setupBleService(provisioningService, "provisioning");
  if (!setupBleCharacteristic(
    provisioningControlCharacteristicImpl,
    CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP,
    SECMODE_NO_ACCESS,
    SECMODE_OPEN,
    244
  )) {
    Serial.println("BLE characteristic registration failed: provisioning control");
  }
  provisioningControlCharacteristicImpl.setWriteCallback(handleProvisioningControlWrite, true);

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
    CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP,
    SECMODE_NO_ACCESS,
    SECMODE_OPEN,
    244
  )) {
    Serial.println("BLE characteristic registration failed: runtime control");
  }
  runtimeControlCharacteristicImpl.setWriteCallback(handleRuntimeControlWrite, true);

  if (!setupBleCharacteristic(
    runtimeStatusCharacteristicImpl,
    CHR_PROPS_READ | CHR_PROPS_NOTIFY | CHR_PROPS_INDICATE,
    SECMODE_OPEN,
    SECMODE_NO_ACCESS,
    244
  )) {
    Serial.println("BLE characteristic registration failed: runtime status");
  }
  runtimeStatusCharacteristicImpl.setCccdWriteCallback(handleRuntimeStatusCccd);

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
    CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP,
    SECMODE_NO_ACCESS,
    SECMODE_OPEN,
    244
  )) {
    Serial.println("BLE characteristic registration failed: history control");
  }
  historyControlCharacteristicImpl.setWriteCallback(handleHistoryControlWrite, true);

  if (!setupBleCharacteristic(
    historyStatusCharacteristicImpl,
    CHR_PROPS_READ | CHR_PROPS_NOTIFY | CHR_PROPS_INDICATE,
    SECMODE_OPEN,
    SECMODE_NO_ACCESS,
    244
  )) {
    Serial.println("BLE characteristic registration failed: history status");
  }
  historyStatusCharacteristicImpl.setCccdWriteCallback(handleHistoryStatusCccd);
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
