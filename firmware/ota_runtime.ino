void finishPendingRestart() {
  if (pendingRebootAt == 0 || millis() < pendingRebootAt) {
    return;
  }

  pendingRebootAt = 0;

  if (!pendingOtaDfuRestart) {
    return;
  }

  pendingOtaDfuRestart = false;
  Bluefruit.Advertising.stop();
  delay(200);
  enterOTADfu();
}

void resetOtaTransferState() {
  otaTransfer.active = false;
  otaTransfer.expectedBytes = 0;
  otaTransfer.receivedBytes = 0;
  otaTransfer.expectedSha256 = "";
  otaTransfer.targetVersion = "";
}

void abortOtaTransfer(const String& reason) {
  pendingOtaDfuRestart = false;
  pendingRebootAt = 0;
  resetOtaTransferState();
  sendRuntimeStatus("error", reason);
}

void beginOtaTransfer(const String& payload) {
  if (otaTransfer.active) {
    abortOtaTransfer("ota-begin-replaced-existing-session");
  }

  const String targetVersion = extractJsonString(payload, "version");
  const size_t expectedBytes = extractJsonSize(payload, "size", 0);
  const String expectedSha256 = extractJsonString(payload, "sha256");

  if (expectedBytes == 0 || targetVersion.length() == 0) {
    sendRuntimeStatus("error", "ota-begin-missing-metadata");
    return;
  }

  pendingOtaDfuRestart = false;
  pendingRebootAt = 0;
  otaTransfer.active = true;
  otaTransfer.targetVersion = targetVersion;
  otaTransfer.expectedBytes = expectedBytes;
  otaTransfer.expectedSha256 = expectedSha256;
  otaTransfer.receivedBytes = 0;

  sendRuntimeStatus(
    "ready",
    "ota-dfu-handoff-ready",
    targetVersion
  );
}

void handleOtaDataWrite(const uint8_t* bytes, size_t length) {
  (void)bytes;
  if (!otaTransfer.active || length == 0) {
    return;
  }

  otaTransfer.receivedBytes += length;
  abortOtaTransfer("ota-runtime-stream-unsupported-on-nrf52");
}

void completeOtaTransfer() {
  if (!otaTransfer.active) {
    sendRuntimeStatus("error", "ota-end-without-session");
    return;
  }

  if (otaTransfer.receivedBytes > 0) {
    abortOtaTransfer("ota-runtime-stream-unsupported-on-nrf52");
    return;
  }

  pendingOtaDfuRestart = true;
  pendingRebootAt = millis() + OTA_DFU_HANDOFF_DELAY_MS;
  sendRuntimeStatus("handoff", "ota-entering-dfu", otaTransfer.targetVersion);
  resetOtaTransferState();
}
