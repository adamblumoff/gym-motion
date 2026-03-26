void loadProvisioningConfig() {
  configuredDeviceId = preferences.getString(PREF_DEVICE_ID, "");
  configuredSiteId = preferences.getString(PREF_SITE_ID, "");
  configuredMachineLabel = preferences.getString(PREF_MACHINE_LABEL, "");
}

void loadHistoryConfig() {
  nextHistorySequence = preferences.getULong(PREF_NEXT_SEQUENCE, 1);
  ackedHistorySequence = preferences.getULong(PREF_ACKED_SEQUENCE, 0);
  historyOverflowed = preferences.getBool(PREF_HISTORY_OVERFLOW, false);
  historyDroppedCount = preferences.getULong(PREF_HISTORY_DROPPED, 0);
}

void clearProvisioningConfig() {
  preferences.remove(PREF_DEVICE_ID);
  preferences.remove(PREF_SITE_ID);
  preferences.remove(PREF_MACHINE_LABEL);
  configuredDeviceId = "";
  configuredSiteId = "";
  configuredMachineLabel = "";
}

void saveProvisioningConfig(
  const String& nextDeviceId,
  const String& nextSiteId,
  const String& nextMachineLabel
) {
  preferences.putString(PREF_DEVICE_ID, nextDeviceId);
  preferences.putString(PREF_SITE_ID, nextSiteId);
  preferences.putString(PREF_MACHINE_LABEL, nextMachineLabel);
  configuredDeviceId = nextDeviceId;
  configuredSiteId = nextSiteId;
  configuredMachineLabel = nextMachineLabel;
}

unsigned long allocateHistorySequence() {
  firmware_runtime::HistorySyncState state;
  state.nextSequence = nextHistorySequence;
  const unsigned long sequence = firmware_runtime::allocateHistorySequence(state);
  nextHistorySequence = state.nextSequence;
  preferences.putULong(PREF_NEXT_SEQUENCE, nextHistorySequence);
  lastJournaledSequence = sequence;
  return sequence;
}

void persistHistoryOverflowState() {
  preferences.putBool(PREF_HISTORY_OVERFLOW, historyOverflowed);
  preferences.putULong(PREF_HISTORY_DROPPED, historyDroppedCount);
}

void replaceHistoryFile(File& tempFile) {
  tempFile.close();
  SPIFFS.remove(HISTORY_LOG_PATH);
  SPIFFS.rename(HISTORY_TEMP_PATH, HISTORY_LOG_PATH);
}

void compactHistoryAboveSequence(unsigned long keepAfterSequence) {
  File source = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!source) {
    return;
  }

  SPIFFS.remove(HISTORY_TEMP_PATH);
  File target = SPIFFS.open(HISTORY_TEMP_PATH, FILE_WRITE);
  if (!target) {
    source.close();
    return;
  }

  while (source.available()) {
    String line = source.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const unsigned long sequence = extractJsonUnsignedLong(line, "sequence", 0);
    if (sequence <= keepAfterSequence) {
      continue;
    }

    target.println(line);
  }

  source.close();
  replaceHistoryFile(target);
}

void dropOldestHistoryRecords(size_t bytesToDrop) {
  File source = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!source) {
    return;
  }

  SPIFFS.remove(HISTORY_TEMP_PATH);
  File target = SPIFFS.open(HISTORY_TEMP_PATH, FILE_WRITE);
  if (!target) {
    source.close();
    return;
  }

  size_t droppedBytes = 0;
  unsigned long droppedRecords = 0;

  while (source.available()) {
    String line = source.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const size_t lineBytes = line.length() + 1;
    if (droppedBytes < bytesToDrop) {
      droppedBytes += lineBytes;
      droppedRecords++;
      continue;
    }

    target.println(line);
  }

  source.close();
  replaceHistoryFile(target);

  if (droppedRecords > 0) {
    historyOverflowed = true;
    historyDroppedCount += droppedRecords;
    persistHistoryOverflowState();
  }
}

void enforceHistoryStorageLimit() {
  File history = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!history) {
    return;
  }

  const size_t currentSize = history.size();
  history.close();

  if (currentSize <= HISTORY_MAX_BYTES) {
    return;
  }

  compactHistoryAboveSequence(ackedHistorySequence);

  history = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!history) {
    return;
  }

  const size_t compactedSize = history.size();
  history.close();

  if (compactedSize <= HISTORY_MAX_BYTES) {
    return;
  }

  const size_t bytesToDrop =
    (compactedSize - HISTORY_MAX_BYTES) + HISTORY_RECLAIM_BYTES;
  dropOldestHistoryRecords(bytesToDrop);
}

void appendHistoryRecord(const String& recordJson) {
  File history = SPIFFS.open(HISTORY_LOG_PATH, FILE_APPEND);
  if (!history) {
    return;
  }

  history.println(recordJson);
  history.close();
  enforceHistoryStorageLimit();
}

void journalNodeLog(
  const String& level,
  const String& code,
  const String& message,
  unsigned long timestamp
) {
  const unsigned long sequence = allocateHistorySequence();
  appendHistoryRecord(
    "{\"kind\":\"node-log\",\"sequence\":" + String(sequence) +
    ",\"level\":\"" + escapeJsonString(level) +
    "\",\"code\":\"" + escapeJsonString(code) +
    "\",\"message\":\"" + escapeJsonString(message) +
    "\",\"timestamp\":" + String(timestamp) +
    ",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}"
  );
}

void journalMotionState(const char* state, int delta, unsigned long timestamp) {
  const unsigned long sequence = allocateHistorySequence();
  appendHistoryRecord(
    "{\"kind\":\"motion\",\"sequence\":" + String(sequence) +
    ",\"state\":\"" + String(state) +
    "\",\"delta\":" + String(delta) +
    ",\"timestamp\":" + String(timestamp) +
    ",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}"
  );
}

void acknowledgeHistoryThrough(unsigned long sequence) {
  firmware_runtime::HistorySyncState state;
  state.nextSequence = nextHistorySequence;
  state.ackedSequence = ackedHistorySequence;
  state.overflowed = historyOverflowed;
  state.droppedCount = historyDroppedCount;
  const firmware_runtime::HistoryAckResult result =
    firmware_runtime::acknowledgeHistoryThrough(state, sequence);

  if (!result.advanced) {
    logRuntimeHistoryEvent(
      "Ack ignored through sequence=" + String(sequence) +
      " currentAckedSequence=" + String(ackedHistorySequence)
    );
    return;
  }

  ackedHistorySequence = state.ackedSequence;
  historyOverflowed = state.overflowed;
  historyDroppedCount = state.droppedCount;
  preferences.putULong(PREF_ACKED_SEQUENCE, ackedHistorySequence);
  compactHistoryAboveSequence(ackedHistorySequence);

  if (result.clearedOverflow) {
    persistHistoryOverflowState();
  }

  logRuntimeHistoryEvent(
    "Ack applied through sequence=" + String(sequence) +
    " ackedHistorySequence=" + String(ackedHistorySequence) +
    " overflowCleared=" + String(result.clearedOverflow ? "true" : "false")
  );
}

void sendHistorySyncComplete(
  const String& requestId,
  unsigned long latestSequence,
  unsigned long highWaterSequence,
  size_t sentCount
) {
  String payload =
    "{\"type\":\"history-page-complete\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"requestId\":\"" + escapeJsonString(requestId) +
    "\",\"latestSequence\":" + String(latestSequence) +
    ",\"highWaterSequence\":" + String(highWaterSequence) +
    ",\"sentCount\":" + String(sentCount) +
    ",\"hasMore\":" + String(latestSequence < highWaterSequence ? "true" : "false");

  if (historyOverflowed) {
    payload += ",\"overflowed\":true,\"droppedCount\":" + String(historyDroppedCount);
  }

  payload += "}";
  enqueueHistoryNotificationChunked(historyStatusCharacteristic, runtimeBleConnected, payload);

  logRuntimeHistoryEvent(
    "Sync complete latestSequence=" + String(latestSequence) +
    " highWaterSequence=" + String(highWaterSequence) +
    " sentCount=" + String(sentCount) +
    " hasMore=" + String(latestSequence < highWaterSequence ? "true" : "false") +
    " overflowed=" + String(historyOverflowed ? "true" : "false")
  );
}

void sendHistoryError(
  const String& sessionId,
  const String& requestId,
  const String& code,
  const String& message
) {
  String payload =
    "{\"type\":\"history-error\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"sessionId\":\"" + escapeJsonString(sessionId) +
    "\",\"requestId\":\"" + escapeJsonString(requestId) +
    "\",\"code\":\"" + escapeJsonString(code) +
    "\",\"message\":\"" + escapeJsonString(message) + "\"}";
  enqueueHistoryNotificationChunked(historyStatusCharacteristic, runtimeBleConnected, payload);
  logRuntimeHistoryEvent(code + ": " + message);
}

void cancelHistoryWorker() {
  if (historyWorkerFile) {
    historyWorkerFile.close();
  }

  historyWorkerState = HistoryWorkerState();
}

void beginHistorySyncRequest(const firmware_runtime::HistoryControlCommand& command) {
  const firmware_runtime::HistorySyncRequest request =
    firmware_runtime::createHistorySyncRequest(command, HISTORY_SYNC_PAGE_SIZE);

  if (!runtimeBleConnected || !runtimeAppSessionConnected) {
    sendHistoryError(
      request.sessionId.c_str(),
      request.requestId.c_str(),
      "history.session_unavailable",
      "History sync requires an active runtime app session."
    );
    return;
  }

  if (request.sessionId.length() == 0 || request.requestId.length() == 0) {
    sendHistoryError(
      request.sessionId.c_str(),
      request.requestId.c_str(),
      "history.invalid_request",
      "History page request requires both sessionId and requestId."
    );
    return;
  }

  if (String(request.sessionId.c_str()) != runtimeAppSessionId) {
    sendHistoryError(
      request.sessionId.c_str(),
      request.requestId.c_str(),
      "history.session_mismatch",
      "History page request did not match the active runtime app session."
    );
    return;
  }

  cancelHistoryWorker();
  historyWorkerState.phase = HistoryWorkerPhase::Streaming;
  historyWorkerState.sessionId = request.sessionId.c_str();
  historyWorkerState.requestId = request.requestId.c_str();
  historyWorkerState.requestedAfterSequence = request.afterSequence;
  historyWorkerState.maxRecords = request.maxRecords;
  historyWorkerState.highWaterSequence = nextHistorySequence > 0 ? nextHistorySequence - 1 : 0;
  historyWorkerState.latestSequence = request.afterSequence;
  historyWorkerState.overflowed = historyOverflowed;
  historyWorkerState.droppedCount = historyDroppedCount;

  historyWorkerFile = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  logRuntimeHistoryEvent(
    "Queued history page request requestId=" + historyWorkerState.requestId +
    " afterSequence=" + String(historyWorkerState.requestedAfterSequence) +
    " maxRecords=" + String(historyWorkerState.maxRecords)
  );
}

void acknowledgeHistorySyncRequest(const firmware_runtime::HistoryControlCommand& command) {
  const firmware_runtime::HistoryAckRequest request =
    firmware_runtime::createHistoryAckRequest(command);

  if (!runtimeAppSessionConnected || String(request.sessionId.c_str()) != runtimeAppSessionId) {
    sendHistoryError(
      request.sessionId.c_str(),
      request.requestId.c_str(),
      "history.ack_session_mismatch",
      "History page ack did not match the active runtime app session."
    );
    return;
  }

  if (request.requestId.length() == 0) {
    sendHistoryError(
      request.sessionId.c_str(),
      request.requestId.c_str(),
      "history.invalid_ack",
      "History page ack requires a requestId."
    );
    return;
  }

  const bool matchesActive =
    historyWorkerState.requestId.length() > 0 &&
    String(request.requestId.c_str()) == historyWorkerState.requestId;
  const bool matchesCompleted =
    lastCompletedHistoryRequestId.length() > 0 &&
    String(request.requestId.c_str()) == lastCompletedHistoryRequestId;

  if (!matchesActive && !matchesCompleted) {
    sendHistoryError(
      request.sessionId.c_str(),
      request.requestId.c_str(),
      "history.ack_request_mismatch",
      "History page ack did not match the active history request."
    );
    return;
  }

  acknowledgeHistoryThrough(request.sequence);

  if (matchesActive && historyWorkerState.phase == HistoryWorkerPhase::AwaitingAck) {
    lastCompletedHistoryRequestId = request.requestId.c_str();
    cancelHistoryWorker();
  }
}

void queueHistoryRecord(const String& requestId, const String& line) {
  enqueueHistoryNotificationChunked(
    historyStatusCharacteristic,
    runtimeBleConnected,
    "{\"type\":\"history-record\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"requestId\":\"" + escapeJsonString(requestId) +
    "\",\"record\":" + line + "}"
  );
}

void pumpHistoryWorker() {
  if (historyWorkerState.phase != HistoryWorkerPhase::Streaming) {
    return;
  }

  if (historyTxQueue.length >= (BLE_TX_QUEUE_CAPACITY / 2)) {
    return;
  }

  if (!historyWorkerFile) {
    historyWorkerState.phase = HistoryWorkerPhase::AwaitingAck;
    sendHistorySyncComplete(
      historyWorkerState.requestId,
      historyWorkerState.latestSequence,
      historyWorkerState.highWaterSequence,
      historyWorkerState.sentCount
    );
    return;
  }

  size_t sentThisSlice = 0;
  while (
    historyWorkerFile.available() &&
    historyWorkerState.sentCount < historyWorkerState.maxRecords &&
    sentThisSlice < HISTORY_WORKER_RECORDS_PER_SLICE &&
    historyTxQueue.length < (BLE_TX_QUEUE_CAPACITY - 8)
  ) {
    String line = historyWorkerFile.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const unsigned long sequence = extractJsonUnsignedLong(line, "sequence", 0);
    if (sequence <= historyWorkerState.requestedAfterSequence) {
      continue;
    }

    queueHistoryRecord(historyWorkerState.requestId, line);
    historyWorkerState.latestSequence = sequence;
    historyWorkerState.sentCount += 1;
    sentThisSlice += 1;
  }

  if (
    historyWorkerState.sentCount >= historyWorkerState.maxRecords ||
    !historyWorkerFile.available()
  ) {
    historyWorkerFile.close();
    historyWorkerState.phase = HistoryWorkerPhase::AwaitingAck;
    sendHistorySyncComplete(
      historyWorkerState.requestId,
      historyWorkerState.latestSequence,
      historyWorkerState.highWaterSequence,
      historyWorkerState.sentCount
    );
  }
}
