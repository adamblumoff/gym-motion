void finishPendingRestart() {
  if (pendingRebootAt == 0 || millis() < pendingRebootAt) {
    return;
  }

  delay(200);
  ESP.restart();
}

void abortOtaTransfer(const String& reason) {
  if (otaTransfer.active) {
    Update.abort();
    mbedtls_sha256_free(&otaTransfer.shaContext);
  }

  otaTransfer.active = false;
  otaTransfer.expectedBytes = 0;
  otaTransfer.receivedBytes = 0;
  otaTransfer.expectedSha256 = "";
  otaTransfer.targetVersion = "";
  sendRuntimeStatus("error", reason);
}

void beginOtaTransfer(const String& payload) {
  if (otaTransfer.active) {
    abortOtaTransfer("ota-begin-replaced-existing-session");
  }

  const size_t expectedBytes = extractJsonSize(payload, "size", 0);
  const String targetVersion = extractJsonString(payload, "version");
  const String expectedSha256 = extractJsonString(payload, "sha256");

  if (expectedBytes == 0 || targetVersion.length() == 0) {
    sendRuntimeStatus("error", "ota-begin-missing-metadata");
    return;
  }

  if (!Update.begin(expectedBytes)) {
    sendRuntimeStatus("error", "update-begin-failed");
    return;
  }

  otaTransfer.active = true;
  otaTransfer.expectedBytes = expectedBytes;
  otaTransfer.receivedBytes = 0;
  otaTransfer.expectedSha256 = expectedSha256;
  otaTransfer.targetVersion = targetVersion;
  mbedtls_sha256_init(&otaTransfer.shaContext);
  mbedtls_sha256_starts(&otaTransfer.shaContext, 0);

  sendRuntimeStatus("ready", "ota-ready", targetVersion);
}

void handleOtaDataWrite(const std::string& rawValue) {
  if (!otaTransfer.active) {
    return;
  }

  uint8_t* bytes = reinterpret_cast<uint8_t*>(const_cast<char*>(rawValue.data()));
  const size_t length = rawValue.length();

  if (length == 0) {
    return;
  }

  if (Update.write(bytes, length) != length) {
    abortOtaTransfer("update-write-failed");
    return;
  }

  mbedtls_sha256_update(&otaTransfer.shaContext, bytes, length);
  otaTransfer.receivedBytes += length;
}

void completeOtaTransfer() {
  if (!otaTransfer.active) {
    sendRuntimeStatus("error", "ota-end-without-session");
    return;
  }

  if (otaTransfer.receivedBytes != otaTransfer.expectedBytes) {
    abortOtaTransfer("ota-size-mismatch");
    return;
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&otaTransfer.shaContext, digest);
  mbedtls_sha256_free(&otaTransfer.shaContext);

  const String actualSha256 = bytesToHex(digest, sizeof(digest));
  if (otaTransfer.expectedSha256.length() > 0 && actualSha256 != otaTransfer.expectedSha256) {
    otaTransfer.active = false;
    Update.abort();
    sendRuntimeStatus("error", "ota-sha256-mismatch", otaTransfer.targetVersion);
    return;
  }

  if (!Update.end() || !Update.isFinished()) {
    otaTransfer.active = false;
    sendRuntimeStatus("error", "update-end-failed", otaTransfer.targetVersion);
    return;
  }

  otaTransfer.active = false;
  sendRuntimeStatus("applied", "ota-applied", otaTransfer.targetVersion);
  pendingRebootAt = millis() + OTA_RESTART_DELAY_MS;
}
