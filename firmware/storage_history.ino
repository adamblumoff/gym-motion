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
  const unsigned long sequence = nextHistorySequence++;
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
  if (sequence <= ackedHistorySequence) {
    return;
  }

  ackedHistorySequence = sequence;
  preferences.putULong(PREF_ACKED_SEQUENCE, ackedHistorySequence);
  compactHistoryAboveSequence(ackedHistorySequence);

  if (historyOverflowed) {
    historyOverflowed = false;
    historyDroppedCount = 0;
    persistHistoryOverflowState();
  }
}

void sendHistorySyncComplete(
  unsigned long latestSequence,
  unsigned long highWaterSequence,
  size_t sentCount
) {
  String payload =
    "{\"type\":\"history-sync-complete\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
    "\",\"latestSequence\":" + String(latestSequence) +
    ",\"highWaterSequence\":" + String(highWaterSequence) +
    ",\"sentCount\":" + String(sentCount) +
    ",\"hasMore\":" + String(latestSequence < highWaterSequence ? "true" : "false");

  if (historyOverflowed) {
    payload += ",\"overflowed\":true,\"droppedCount\":" + String(historyDroppedCount);
  }

  payload += "}";
  notifyCharacteristicChunked(runtimeStatusCharacteristic, runtimeBleConnected, payload);
}

void streamHistoryRecords(unsigned long afterSequence, size_t maxRecords) {
  File history = SPIFFS.open(HISTORY_LOG_PATH, FILE_READ);
  const unsigned long highWaterSequence =
    nextHistorySequence > 0 ? nextHistorySequence - 1 : 0;

  if (!history) {
    sendHistorySyncComplete(afterSequence, highWaterSequence, 0);
    return;
  }

  size_t sentCount = 0;
  unsigned long latestSequence = afterSequence;

  while (history.available()) {
    String line = history.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const unsigned long sequence = extractJsonUnsignedLong(line, "sequence", 0);
    if (sequence <= afterSequence) {
      continue;
    }

    if (sentCount >= maxRecords) {
      break;
    }

    notifyCharacteristicChunked(
      runtimeStatusCharacteristic,
      runtimeBleConnected,
      "{\"type\":\"history-record\",\"deviceId\":\"" + escapeJsonString(activeDeviceId()) +
      "\",\"record\":" + line + "}"
    );
    latestSequence = sequence;
    sentCount++;
  }

  history.close();
  sendHistorySyncComplete(latestSequence, highWaterSequence, sentCount);
}
