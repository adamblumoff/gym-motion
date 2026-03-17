void replaceDebugFile(File& tempFile) {
  tempFile.close();
  SPIFFS.remove(DEBUG_LOG_PATH);
  SPIFFS.rename(DEBUG_TEMP_PATH, DEBUG_LOG_PATH);
}

void trimDebugLogToLimit() {
  File debugLog = SPIFFS.open(DEBUG_LOG_PATH, FILE_READ);
  if (!debugLog) {
    return;
  }

  const size_t currentSize = debugLog.size();
  debugLog.close();

  if (currentSize <= DEBUG_LOG_MAX_BYTES) {
    return;
  }

  SPIFFS.remove(DEBUG_TEMP_PATH);
  File source = SPIFFS.open(DEBUG_LOG_PATH, FILE_READ);
  File target = SPIFFS.open(DEBUG_TEMP_PATH, FILE_WRITE);

  if (!source || !target) {
    if (source) {
      source.close();
    }

    if (target) {
      target.close();
    }

    return;
  }

  const size_t bytesToDrop = currentSize - DEBUG_LOG_MAX_BYTES;
  size_t droppedBytes = 0;

  while (source.available()) {
    String line = source.readStringUntil('\n');
    line.trim();

    if (line.length() == 0) {
      continue;
    }

    const size_t lineBytes = line.length() + 1;
    if (droppedBytes < bytesToDrop) {
      droppedBytes += lineBytes;
      continue;
    }

    target.println(line);
  }

  source.close();
  replaceDebugFile(target);
}

void appendDebugRecord(const String& recordJson) {
  File debugLog = SPIFFS.open(DEBUG_LOG_PATH, FILE_APPEND);
  if (!debugLog) {
    return;
  }

  debugLog.println(recordJson);
  debugLog.close();
  trimDebugLogToLimit();
}

void journalNodeLog(
  const String& level,
  const String& code,
  const String& message,
  unsigned long timestamp
) {
  appendDebugRecord(
    "{\"level\":\"" + escapeJsonString(level) +
    "\",\"code\":\"" + escapeJsonString(code) +
    "\",\"message\":\"" + escapeJsonString(message) +
    "\",\"timestamp\":" + String(timestamp) +
    ",\"bootId\":\"" + escapeJsonString(bootId) +
    "\",\"firmwareVersion\":\"" + String(FIRMWARE_VERSION) +
    "\",\"hardwareId\":\"" + escapeJsonString(hardwareId) + "\"}"
  );
}
