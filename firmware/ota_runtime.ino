void finishPendingRestart() {
  // USB DFU or bench flashing is the first-pass firmware update path on XIAO.
  pendingRebootAt = 0;
}

void abortOtaTransfer(const String& reason) {
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

  const String targetVersion = extractJsonString(payload, "version");
  otaTransfer.active = true;
  otaTransfer.targetVersion = targetVersion;
  otaTransfer.expectedBytes = extractJsonSize(payload, "size", 0);
  otaTransfer.expectedSha256 = extractJsonString(payload, "sha256");
  otaTransfer.receivedBytes = 0;

  sendRuntimeStatus(
    "error",
    "ota-not-supported-on-xiao-first-pass",
    targetVersion
  );
  otaTransfer.active = false;
}

void handleOtaDataWrite(const uint8_t* bytes, size_t length) {
  (void)bytes;
  (void)length;
}

void completeOtaTransfer() {
  sendRuntimeStatus("error", "ota-not-supported-on-xiao-first-pass");
  otaTransfer.active = false;
}
