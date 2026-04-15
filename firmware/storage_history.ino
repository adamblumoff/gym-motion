namespace {
bool filesystemReady = false;
bool filesystemInitAttempted = false;
bool persistedStateDirty = false;
unsigned long persistedStateLastDirtyAt = 0;
void logStorageEvent(const String& message) {
  Serial.print("[storage] ");
  Serial.println(message);
}
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
    logStorageEvent(String("read miss path=") + path);
    return false;
  }

  File file = SPIFFS.open(path, FILE_READ);
  if (!file) {
    logStorageEvent(String("read open failed path=") + path);
    return false;
  }

  contents = "";
  while (file.available()) {
    contents += static_cast<char>(file.read());
  }
  file.close();
  logStorageEvent(
    String("read complete path=") + path +
    " bytes=" + String(contents.length())
  );
  return contents.length() > 0;
}

bool loadPersistedStateFromPayload(const String& payload) {
  firmware_runtime::PersistedStateSnapshot snapshot;
  if (!firmware_runtime::parsePersistedStatePayload(payload.c_str(), snapshot)) {
    logStorageEvent("payload parse rejected");
    return false;
  }

  configuredDeviceId = snapshot.deviceId.c_str();
  configuredSiteId = snapshot.siteId.c_str();
  configuredMachineLabel = snapshot.machineLabel.c_str();
  nextHistorySequence = snapshot.nextHistorySequence;
  ackedHistorySequence = snapshot.ackedHistorySequence;
  historyOverflowed = snapshot.historyOverflowed;
  historyDroppedCount = snapshot.historyDroppedCount;
  logStorageEvent(
    "payload parse accepted deviceId=" + configuredDeviceId +
    " nextSeq=" + String(nextHistorySequence) +
    " ackedSeq=" + String(ackedHistorySequence)
  );
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
  logStorageEvent(String("write file begin path=") + path);
  SPIFFS.remove(path);
  logStorageEvent(String("write file removed existing path=") + path);

  File file = SPIFFS.open(path, FILE_WRITE);
  if (!file) {
    logStorageEvent(String("write file open failed path=") + path);
    return false;
  }
  logStorageEvent(String("write file opened path=") + path);

  const size_t written = file.write(payload.c_str(), payload.length());
  logStorageEvent(
    String("write file wrote path=") + path +
    " bytes=" + String(written)
  );
  file.flush();
  logStorageEvent(String("write file flushed path=") + path);
  file.close();
  logStorageEvent(String("write file closed path=") + path);
  return written == payload.length();
}

void ensureFilesystemReady() {
  if (filesystemReady) {
    logStorageEvent("filesystem already ready");
    return;
  }

  if (filesystemInitAttempted) {
    logStorageEvent("filesystem init already attempted");
    return;
  }

  filesystemInitAttempted = true;
  logStorageEvent("mount begin");
  filesystemReady = SPIFFS.begin();
  if (!filesystemReady) {
    logStorageEvent("mount failed");
    Serial.println("LittleFS mount failed; preserving on-device state and skipping filesystem writes.");
    return;
  }

  logStorageEvent("mount ok");
}

void loadPersistedState() {
  logStorageEvent("load begin");
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
  logStorageEvent(
    "load probe primaryValid=" + String(primaryValid ? "true" : "false") +
    " backupValid=" + String(backupValid ? "true" : "false")
  );
  const auto action = firmware_runtime::decidePersistedStateLoadAction(
    filesystemReady,
    primaryValid,
    backupValid
  );

  if (action == firmware_runtime::PersistedStateLoadAction::SkipFilesystem) {
    logStorageEvent("load action skip-filesystem");
    return;
  }

  if (action == firmware_runtime::PersistedStateLoadAction::UsePrimary) {
    logStorageEvent("load action use-primary");
    return;
  }

  if (action == firmware_runtime::PersistedStateLoadAction::UseBackup) {
    logStorageEvent("load action use-backup");
    savePersistedState();
    return;
  }

  logStorageEvent("load action initialize-defaults");
  savePersistedState();
}

bool flushPersistedStateNowImpl() {
  logStorageEvent("save begin");
  ensureFilesystemReady();
  if (!filesystemReady) {
    logStorageEvent("save skipped filesystem unavailable");
    return false;
  }
  const String payload = buildPersistedStatePayload();
  logStorageEvent("save payload bytes=" + String(payload.length()));

  if (!writePersistedStateFile(PREFS_TEMP_FILE_PATH, payload)) {
    logStorageEvent("save temp write failed");
    return false;
  }

  logStorageEvent("save removing backup");
  SPIFFS.remove(PREFS_BACKUP_FILE_PATH);
  logStorageEvent("save removed backup");
  if (SPIFFS.exists(PREFS_FILE_PATH) &&
      !SPIFFS.rename(PREFS_FILE_PATH, PREFS_BACKUP_FILE_PATH)) {
    logStorageEvent("save primary->backup rename failed");
    SPIFFS.remove(PREFS_TEMP_FILE_PATH);
    return false;
  }
  if (SPIFFS.exists(PREFS_FILE_PATH)) {
    logStorageEvent("save primary->backup rename ok");
  }

  logStorageEvent("save renaming temp->primary");
  if (!SPIFFS.rename(PREFS_TEMP_FILE_PATH, PREFS_FILE_PATH)) {
    logStorageEvent("save temp->primary rename failed");
    if (SPIFFS.exists(PREFS_BACKUP_FILE_PATH)) {
      SPIFFS.rename(PREFS_BACKUP_FILE_PATH, PREFS_FILE_PATH);
    }
    SPIFFS.remove(PREFS_TEMP_FILE_PATH);
    return false;
  }

  logStorageEvent("save temp->primary rename ok");
  SPIFFS.remove(PREFS_BACKUP_FILE_PATH);
  logStorageEvent("save final backup cleanup done");
  logStorageEvent("save complete");
  return true;
}

void savePersistedState() {
  persistedStateDirty = true;
  persistedStateLastDirtyAt = millis();
  logStorageEvent("save scheduled");
}

void flushPersistedStateIfNeeded() {
  if (!persistedStateDirty) {
    return;
  }

  const unsigned long now = millis();
  if (now - persistedStateLastDirtyAt < PERSISTED_STATE_SAVE_DEBOUNCE_MS) {
    return;
  }

  persistedStateDirty = false;
  if (!flushPersistedStateNowImpl()) {
    persistedStateDirty = true;
    persistedStateLastDirtyAt = now;
  }
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
    "\",\"firmwareVersion\":\"" + firmwareVersionString() +
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
    "\",\"firmwareVersion\":\"" + firmwareVersionString() +
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
  writeCharacteristicValue(historyStatusCharacteristic, payload);
  writeCharacteristicValue(runtimeStatusCharacteristic, payload);
  if (!enqueueRuntimeStatusPayload(payload)) {
    return false;
  }

  logRuntimeHistoryEvent(
    "Sync complete latestSequence=" + String(latestSequence) +
    " highWaterSequence=" + String(highWaterSequence) +
    " sentCount=" + String(sentCount) +
    " hasMore=" + String(latestSequence < highWaterSequence ? "true" : "false") +
    " overflowed=" + String(historyOverflowed ? "true" : "false")
  );
  sendHistoryDebugStatus("complete", requestId, latestSequence, sentCount, "", "");
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
  writeCharacteristicValue(historyStatusCharacteristic, payload);
  writeCharacteristicValue(runtimeStatusCharacteristic, payload);
  if (!enqueueRuntimeStatusPayload(payload)) {
    return false;
  }
  logRuntimeHistoryEvent(code + ": " + message);
  sendHistoryDebugStatus("error", requestId, 0, 0, code, message);
  return true;
}

void cancelHistoryWorker() {
  if (historyWorkerFile) {
    historyWorkerFile.close();
  }

  historyWorkerState = HistoryWorkerState();
}

void finishOrContinueHistorySync() {
  const String sessionId = historyWorkerState.sessionId;
  const String requestId = historyWorkerState.requestId;
  const size_t maxRecords = historyWorkerState.maxRecords;
  const unsigned long latestSequence = historyWorkerState.latestSequence;
  const unsigned long highWaterSequence = historyWorkerState.highWaterSequence;
  const size_t sentCount = historyWorkerState.sentCount;
  const bool hasMore = latestSequence < highWaterSequence;

  if (!sendHistorySyncComplete(
        requestId,
        latestSequence,
        highWaterSequence,
        sentCount
      )) {
    return;
  }

  if (!hasMore) {
    lastCompletedHistoryRequestId = requestId;
    cancelHistoryWorker();
    return;
  }

  firmware_runtime::HistoryControlCommand nextCommand;
  nextCommand.type = firmware_runtime::HistoryControlCommandType::HistoryPageRequest;
  nextCommand.sessionId = sessionId.c_str();
  nextCommand.requestId = requestId.c_str();
  nextCommand.afterSequence = latestSequence;
  nextCommand.maxRecords = maxRecords;

  logRuntimeHistoryEvent(
    "Continuing firmware-owned history sync requestId=" + requestId +
    " afterSequence=" + String(latestSequence) +
    " highWaterSequence=" + String(highWaterSequence)
  );
  cancelHistoryWorker();
  scheduleHistorySyncRequest(nextCommand);
}

void maybeStartAutomaticHistorySync() {
  auto publishAutoHistoryDecision = [&](const String& message) {
    if (message == lastAutoHistoryDecisionMessage) {
      return;
    }
    lastAutoHistoryDecisionMessage = message;
    enqueueBoardLogStatus("auto-history", message);
    sendHistoryDebugStatus(
      "auto-decision",
      runtimeAppSessionId,
      ackedHistorySequence,
      0,
      "",
      message
    );
  };

  if (!runtimeBleConnected || !runtimeAppSessionConnected) {
    publishAutoHistoryDecision(
      "Skipped automatic history start: runtime/session unavailable ble=" +
      String(runtimeBleConnected ? "1" : "0") +
      " session=" + String(runtimeAppSessionConnected ? "1" : "0")
    );
    return;
  }

  if ((runtimeNotifyMask & RUNTIME_NOTIFY_MASK_HISTORY) == 0) {
    publishAutoHistoryDecision(
      "Skipped automatic history start: history notify disabled mask=" +
      String(runtimeNotifyMask)
    );
    return;
  }

  if (pendingHistorySyncRequest || historyWorkerState.phase != HistoryWorkerPhase::Idle) {
    publishAutoHistoryDecision(
      "Skipped automatic history start: pending=" +
      String(pendingHistorySyncRequest ? "1" : "0") +
      " phase=" + String(static_cast<int>(historyWorkerState.phase))
    );
    return;
  }

  const unsigned long highWaterSequence = nextHistorySequence > 0 ? nextHistorySequence - 1 : 0;
  if (highWaterSequence <= ackedHistorySequence) {
    publishAutoHistoryDecision(
      "Skipped automatic history start: already caught up session=" +
      runtimeAppSessionId + " acked=" + String(ackedHistorySequence) +
      " highWater=" + String(highWaterSequence)
    );
    return;
  }

  firmware_runtime::HistoryControlCommand command;
  command.type = firmware_runtime::HistoryControlCommandType::HistoryPageRequest;
  command.sessionId = runtimeAppSessionId.c_str();
  command.requestId =
    ("auto-" + runtimeAppSessionId + "-" + String(ackedHistorySequence)).c_str();
  command.afterSequence = ackedHistorySequence;
  command.maxRecords = HISTORY_SYNC_PAGE_SIZE;

  publishAutoHistoryDecision(
    "Scheduling automatic history start session=" + runtimeAppSessionId +
    " acked=" + String(ackedHistorySequence) +
    " highWater=" + String(highWaterSequence)
  );

  sendHistoryDebugStatus(
    "auto-request",
    command.requestId.c_str(),
    command.afterSequence,
    0,
    "",
    "highWater=" + String(highWaterSequence)
  );
  scheduleHistorySyncRequest(command);
}

void scheduleHistorySyncRequest(const firmware_runtime::HistoryControlCommand& command) {
  pendingHistorySyncCommand = command;
  pendingHistorySyncRequest = true;
}

void processPendingHistorySyncRequest() {
  if (!pendingHistorySyncRequest) {
    return;
  }

  const firmware_runtime::HistoryControlCommand command = pendingHistorySyncCommand;
  pendingHistorySyncRequest = false;
  beginHistorySyncRequest(command);
}

void beginHistorySyncRequest(const firmware_runtime::HistoryControlCommand& command) {
  const firmware_runtime::HistorySyncRequest request =
    firmware_runtime::createHistorySyncRequest(command, HISTORY_SYNC_PAGE_SIZE);
  const String effectiveSessionId =
    request.sessionId.length() > 0 ? String(request.sessionId.c_str()) : runtimeAppSessionId;
  const bool shortReconnectToken = effectiveSessionId.length() == 8;
  const bool sessionMatches = shortReconnectToken
    ? runtimeAppSessionId.startsWith(effectiveSessionId)
    : effectiveSessionId == runtimeAppSessionId;

  if (!runtimeBleConnected || !runtimeAppSessionConnected) {
    sendHistoryError(
      effectiveSessionId,
      request.requestId.c_str(),
      "history.session_unavailable",
      "History sync requires an active runtime app session."
    );
    return;
  }

  if (request.requestId.length() == 0) {
    sendHistoryError(
      effectiveSessionId,
      request.requestId.c_str(),
      "history.invalid_request",
      "History page request requires a requestId."
    );
    return;
  }

  if (!sessionMatches) {
    sendHistoryError(
      effectiveSessionId,
      request.requestId.c_str(),
      "history.session_mismatch",
      "History page request did not match the active runtime app session."
    );
    return;
  }

  cancelHistoryWorker();
  historyWorkerState.phase = HistoryWorkerPhase::Streaming;
  historyWorkerState.sessionId = effectiveSessionId;
  historyWorkerState.requestId = request.requestId.c_str();
  historyWorkerState.requestedAfterSequence = request.afterSequence;
  historyWorkerState.maxRecords = request.maxRecords;
  historyWorkerState.highWaterSequence = nextHistorySequence > 0 ? nextHistorySequence - 1 : 0;
  historyWorkerState.latestSequence = request.afterSequence;
  historyWorkerState.overflowed = historyOverflowed;
  historyWorkerState.droppedCount = historyDroppedCount;

  sendHistoryDebugStatus(
    "request",
    historyWorkerState.requestId,
    historyWorkerState.requestedAfterSequence,
    0,
    "",
    "highWater=" + String(historyWorkerState.highWaterSequence)
  );

  if (historyWorkerState.requestedAfterSequence >= historyWorkerState.highWaterSequence) {
    if (sendHistorySyncComplete(
          historyWorkerState.requestId,
          historyWorkerState.requestedAfterSequence,
          historyWorkerState.highWaterSequence,
          0
        )) {
      lastCompletedHistoryRequestId = historyWorkerState.requestId;
      cancelHistoryWorker();
    }
    return;
  }

  historyWorkerFile = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  if (!historyWorkerFile) {
    sendHistoryDebugStatus(
      "request-no-file",
      historyWorkerState.requestId,
      historyWorkerState.requestedAfterSequence,
      0,
      "",
      ""
    );
  }
  logRuntimeHistoryEvent(
    "Queued history page request requestId=" + historyWorkerState.requestId +
    " afterSequence=" + String(historyWorkerState.requestedAfterSequence) +
    " maxRecords=" + String(historyWorkerState.maxRecords)
  );
}

void acknowledgeHistorySyncRequest(const firmware_runtime::HistoryControlCommand& command) {
  const firmware_runtime::HistoryAckRequest request =
    firmware_runtime::createHistoryAckRequest(command);
  const String effectiveSessionId =
    request.sessionId.length() > 0 ? String(request.sessionId.c_str()) : runtimeAppSessionId;
  const bool shortReconnectToken = effectiveSessionId.length() == 8;
  const bool sessionMatches = shortReconnectToken
    ? runtimeAppSessionId.startsWith(effectiveSessionId)
    : effectiveSessionId == runtimeAppSessionId;

  if (!runtimeAppSessionConnected || !sessionMatches) {
    sendHistoryError(
      effectiveSessionId,
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

  if (!matchesActive) {
    if (String(request.requestId.c_str()) == lastCompletedHistoryRequestId) {
      logRuntimeHistoryEvent(
        "Ignored legacy history ack for completed requestId=" + String(request.requestId.c_str()) +
        " sequence=" + String(request.sequence)
      );
      return;
    }

    sendHistoryError(
      request.sessionId.c_str(),
      request.requestId.c_str(),
      "history.ack_request_mismatch",
      "History page ack did not match the active history request."
    );
    return;
  }

  acknowledgeHistoryThrough(request.sequence);
  cancelHistoryWorker();
}

void pumpHistoryWorker() {
  if (historyWorkerState.phase != HistoryWorkerPhase::Streaming) {
    return;
  }

  if (!historyWorkerFile) {
    finishOrContinueHistorySync();
    return;
  }

  if (!historyWorkerState.pumpStartedLogged) {
    historyWorkerState.pumpStartedLogged = true;
    sendHistoryDebugStatus(
      "pump-start",
      historyWorkerState.requestId,
      historyWorkerState.requestedAfterSequence,
      historyWorkerState.sentCount,
      "",
      "fileSize=" + String(historyWorkerFile.size())
    );
  }

  size_t sentThisSlice = 0;
  while (
    historyWorkerFile.available() &&
    historyWorkerState.sentCount < historyWorkerState.maxRecords &&
    sentThisSlice < HISTORY_WORKER_RECORDS_PER_SLICE
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

    const String payload =
      "{\"type\":\"history-record\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
      "\",\"requestId\":\"" + escapeJsonString(historyWorkerState.requestId) +
      "\",\"record\":" + line + "}";
    const size_t requiredSlots =
      payload.length() <= 244 ? 1 : chunkedNotificationSlotCount(payload.length());
    if (requiredSlots > BLE_TX_QUEUE_CAPACITY) {
      sendHistoryDebugStatus(
        "record-too-large",
        historyWorkerState.requestId,
        sequence,
        historyWorkerState.sentCount,
        "",
        "payloadLen=" + String(payload.length())
      );
      continue;
    }

    if (payload.length() <= 244) {
      writeCharacteristicValue(historyStatusCharacteristic, payload);
      writeCharacteristicValue(runtimeStatusCharacteristic, payload);
    }

    if (!enqueueRuntimeStatusPayload(payload)) {
      sendHistoryDebugStatus(
        "record-queue-blocked",
        historyWorkerState.requestId,
        sequence,
        historyWorkerState.sentCount,
        "",
        "payloadLen=" + String(payload.length()) +
          " requiredSlots=" + String(requiredSlots) +
          " runtimeQueueLen=" + String(runtimeTxQueue.length)
      );
      break;
    }

    if (!historyWorkerState.firstRecordLogged) {
      historyWorkerState.firstRecordLogged = true;
      sendHistoryDebugStatus(
        "first-record-queued",
        historyWorkerState.requestId,
        sequence,
        historyWorkerState.sentCount + 1,
        "",
        "payloadLen=" + String(payload.length())
      );
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
    finishOrContinueHistorySync();
  }
}
