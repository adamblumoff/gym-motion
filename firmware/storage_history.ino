namespace {
bool filesystemReady = false;
bool filesystemInitAttempted = false;
}

String buildPersistedStatePayload() {
  return
    "{\"" + String(PREF_DEVICE_ID) + "\":\"" + escapeJsonString(configuredDeviceId) +
    "\",\"" + String(PREF_SITE_ID) + "\":\"" + escapeJsonString(configuredSiteId) +
    "\",\"" + String(PREF_MACHINE_LABEL) + "\":\"" + escapeJsonString(configuredMachineLabel) +
    "\",\"" + String(PREF_NEXT_SEQUENCE) + "\":" + String(nextHistorySequence) +
    ",\"" + String(PREF_ACKED_SEQUENCE) + "\":" + String(ackedHistorySequence) +
    ",\"" + String(PREF_HISTORY_OVERFLOW) + "\":" + String(historyOverflowed ? 1 : 0) +
    ",\"" + String(PREF_HISTORY_DROPPED) + "\":" + String(historyDroppedCount) + "}";
}

bool readFileIntoString(const char* path, String& contents) {
  if (!SPIFFS.exists(path)) {
    return false;
  }

  File file = SPIFFS.open(path, FILE_READ);
  if (!file) {
    return false;
  }

  contents = "";
  while (file.available()) {
    contents += static_cast<char>(file.read());
  }
  file.close();
  return contents.length() > 0;
}

bool loadPersistedStateFromPayload(const String& payload) {
  firmware_runtime::PersistedStateSnapshot snapshot;
  if (!firmware_runtime::parsePersistedStatePayload(payload.c_str(), snapshot)) {
    return false;
  }

  configuredDeviceId = snapshot.deviceId.c_str();
  configuredSiteId = snapshot.siteId.c_str();
  configuredMachineLabel = snapshot.machineLabel.c_str();
  nextHistorySequence = snapshot.nextHistorySequence;
  ackedHistorySequence = snapshot.ackedHistorySequence;
  historyOverflowed = snapshot.historyOverflowed;
  historyDroppedCount = snapshot.historyDroppedCount;
  return true;
}

bool loadPersistedStateFromFile(const char* path) {
  String payload;
  if (!readFileIntoString(path, payload)) {
    return false;
  }

  return loadPersistedStateFromPayload(payload);
}

bool writePersistedStateFile(const char* path, const String& payload) {
  SPIFFS.remove(path);

  File file = SPIFFS.open(path, FILE_WRITE);
  if (!file) {
    return false;
  }

  const size_t written = file.write(payload.c_str(), payload.length());
  file.flush();
  file.close();
  return written == payload.length();
}

void ensureFilesystemReady() {
  if (filesystemReady) {
    return;
  }

  if (filesystemInitAttempted) {
    return;
  }

  filesystemInitAttempted = true;
  filesystemReady = SPIFFS.begin();
  if (!filesystemReady) {
    Serial.println("LittleFS mount failed; preserving on-device state and skipping filesystem writes.");
  }
}

void loadPersistedState() {
  ensureFilesystemReady();

  configuredDeviceId = "";
  configuredSiteId = "";
  configuredMachineLabel = "";
  nextHistorySequence = 1;
  ackedHistorySequence = 0;
  historyOverflowed = false;
  historyDroppedCount = 0;

  const bool primaryValid = filesystemReady && loadPersistedStateFromFile(PREFS_FILE_PATH);
  const bool backupValid = !primaryValid && filesystemReady && loadPersistedStateFromFile(PREFS_BACKUP_FILE_PATH);
  const auto action = firmware_runtime::decidePersistedStateLoadAction(
    filesystemReady,
    primaryValid,
    backupValid
  );

  if (action == firmware_runtime::PersistedStateLoadAction::SkipFilesystem) {
    return;
  }

  if (action == firmware_runtime::PersistedStateLoadAction::UsePrimary) {
    return;
  }

  if (action == firmware_runtime::PersistedStateLoadAction::UseBackup) {
    savePersistedState();
    return;
  }

  savePersistedState();
}

void savePersistedState() {
  ensureFilesystemReady();
  if (!filesystemReady) {
    return;
  }
  const String payload = buildPersistedStatePayload();

  if (!writePersistedStateFile(PREFS_TEMP_FILE_PATH, payload)) {
    return;
  }

  SPIFFS.remove(PREFS_BACKUP_FILE_PATH);
  if (SPIFFS.exists(PREFS_FILE_PATH) &&
      !SPIFFS.rename(PREFS_FILE_PATH, PREFS_BACKUP_FILE_PATH)) {
    SPIFFS.remove(PREFS_TEMP_FILE_PATH);
    return;
  }

  if (!SPIFFS.rename(PREFS_TEMP_FILE_PATH, PREFS_FILE_PATH)) {
    if (SPIFFS.exists(PREFS_BACKUP_FILE_PATH)) {
      SPIFFS.rename(PREFS_BACKUP_FILE_PATH, PREFS_FILE_PATH);
    }
    SPIFFS.remove(PREFS_TEMP_FILE_PATH);
    return;
  }

  SPIFFS.remove(PREFS_BACKUP_FILE_PATH);
}

void clearProvisioningConfig() {
  configuredDeviceId = "";
  configuredSiteId = "";
  configuredMachineLabel = "";
  savePersistedState();
}

void saveProvisioningConfig(
  const String& nextDeviceId,
  const String& nextSiteId,
  const String& nextMachineLabel
) {
  configuredDeviceId = nextDeviceId;
  configuredSiteId = nextSiteId;
  configuredMachineLabel = nextMachineLabel;
  savePersistedState();
}

unsigned long allocateHistorySequence() {
  firmware_runtime::HistorySyncState state;
  state.nextSequence = nextHistorySequence;
  const unsigned long sequence = firmware_runtime::allocateHistorySequence(state);
  nextHistorySequence = state.nextSequence;
  savePersistedState();
  lastJournaledSequence = sequence;
  return sequence;
}

void persistHistoryOverflowState() {
  savePersistedState();
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
  savePersistedState();
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

bool sendHistorySyncComplete(
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
  if (!enqueueHistoryNotificationChunked(historyStatusCharacteristic, payload)) {
    return false;
  }

  logRuntimeHistoryEvent(
    "Sync complete latestSequence=" + String(latestSequence) +
    " highWaterSequence=" + String(highWaterSequence) +
    " sentCount=" + String(sentCount) +
    " hasMore=" + String(latestSequence < highWaterSequence ? "true" : "false") +
    " overflowed=" + String(historyOverflowed ? "true" : "false")
  );
  return true;
}

bool sendHistoryError(
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
  if (!enqueueHistoryNotificationChunked(historyStatusCharacteristic, payload)) {
    return false;
  }
  logRuntimeHistoryEvent(code + ": " + message);
  return true;
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

bool queueHistoryRecord(const String& requestId, const String& line) {
  return enqueueHistoryNotificationChunked(
    historyStatusCharacteristic,
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
    if (sendHistorySyncComplete(
          historyWorkerState.requestId,
          historyWorkerState.latestSequence,
          historyWorkerState.highWaterSequence,
          historyWorkerState.sentCount
        )) {
      historyWorkerState.phase = HistoryWorkerPhase::AwaitingAck;
    }
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

    // History logs are append-only and sequences should be strictly increasing.
    // If an older sequence reappears later in the file, treat it as stale
    // corruption from a previously malformed sync and skip it.
    if (sequence <= historyWorkerState.latestSequence) {
      continue;
    }

    if (!queueHistoryRecord(historyWorkerState.requestId, line)) {
      break;
    }
    historyWorkerState.latestSequence = sequence;
    historyWorkerState.sentCount += 1;
    sentThisSlice += 1;
  }

  if (
    historyWorkerState.sentCount >= historyWorkerState.maxRecords ||
    !historyWorkerFile.available()
  ) {
    if (!historyWorkerFile.available()) {
      historyWorkerState.highWaterSequence = historyWorkerState.latestSequence;
    }
    historyWorkerFile.close();
    if (sendHistorySyncComplete(
          historyWorkerState.requestId,
          historyWorkerState.latestSequence,
          historyWorkerState.highWaterSequence,
          historyWorkerState.sentCount
        )) {
      historyWorkerState.phase = HistoryWorkerPhase::AwaitingAck;
    }
  }
}
