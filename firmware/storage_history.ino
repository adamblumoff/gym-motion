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
    "\"}";
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
  logStorageEvent("payload parse accepted deviceId=" + configuredDeviceId);
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

  const bool primaryValid = filesystemReady && loadPersistedStateFromFile(PREFS_FILE_PATH);
  const bool backupValid =
    !primaryValid && filesystemReady && loadPersistedStateFromFile(PREFS_BACKUP_FILE_PATH);
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

bool flushPersistedStateNow() {
  persistedStateDirty = false;
  const bool saved = flushPersistedStateNowImpl();
  if (!saved) {
    persistedStateDirty = true;
    persistedStateLastDirtyAt = millis();
  }
  return saved;
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
