#include "persisted_state.hpp"

#include <cstdlib>

namespace firmware_runtime {

namespace {

bool hasKey(const std::string& json, const char* key) {
  return json.find("\"" + std::string(key) + "\"") != std::string::npos;
}

std::string extractJsonStringValue(const std::string& json, const char* key) {
  const std::string token = "\"" + std::string(key) + "\":\"";
  const std::size_t start = json.find(token);
  if (start == std::string::npos) {
    return "";
  }

  const std::size_t valueStart = start + token.length();
  std::size_t valueEnd = valueStart;
  while (valueEnd < json.length()) {
    if (json[valueEnd] == '"' && (valueEnd == valueStart || json[valueEnd - 1] != '\\')) {
      break;
    }
    valueEnd++;
  }

  std::string value = json.substr(valueStart, valueEnd - valueStart);
  std::size_t position = 0;
  while ((position = value.find("\\/", position)) != std::string::npos) {
    value.replace(position, 2, "/");
  }
  position = 0;
  while ((position = value.find("\\\"", position)) != std::string::npos) {
    value.replace(position, 2, "\"");
  }
  return value;
}

unsigned long extractJsonUnsignedLongValue(
  const std::string& json,
  const char* key,
  unsigned long fallback
) {
  const std::string token = "\"" + std::string(key) + "\":";
  const std::size_t start = json.find(token);
  if (start == std::string::npos) {
    return fallback;
  }

  std::size_t valueStart = start + token.length();
  while (valueStart < json.length() && json[valueStart] == ' ') {
    valueStart++;
  }

  std::size_t valueEnd = valueStart;
  while (valueEnd < json.length() && json[valueEnd] >= '0' && json[valueEnd] <= '9') {
    valueEnd++;
  }

  if (valueEnd == valueStart) {
    return fallback;
  }

  return static_cast<unsigned long>(
    std::strtoull(json.substr(valueStart, valueEnd - valueStart).c_str(), nullptr, 10)
  );
}

}  // namespace

bool parsePersistedStatePayload(
  const std::string& payload,
  PersistedStateSnapshot& snapshot
) {
  if (payload.empty() || payload.front() != '{' || payload.back() != '}') {
    return false;
  }

  const char* requiredKeys[] = {
    "device_id",
    "site_id",
    "machine_label",
    "next_seq",
    "acked_seq",
    "hist_ovf",
    "hist_drop",
  };

  for (const char* key : requiredKeys) {
    if (!hasKey(payload, key)) {
      return false;
    }
  }

  PersistedStateSnapshot parsed;
  parsed.deviceId = extractJsonStringValue(payload, "device_id");
  parsed.siteId = extractJsonStringValue(payload, "site_id");
  parsed.machineLabel = extractJsonStringValue(payload, "machine_label");
  parsed.nextHistorySequence = extractJsonUnsignedLongValue(payload, "next_seq", 1);
  parsed.ackedHistorySequence = extractJsonUnsignedLongValue(payload, "acked_seq", 0);
  parsed.historyOverflowed = extractJsonUnsignedLongValue(payload, "hist_ovf", 0) != 0;
  parsed.historyDroppedCount = extractJsonUnsignedLongValue(payload, "hist_drop", 0);

  if (
    parsed.nextHistorySequence == 0 ||
    parsed.ackedHistorySequence >= parsed.nextHistorySequence
  ) {
    return false;
  }

  const bool anyProvisioningValue =
    !parsed.deviceId.empty() || !parsed.siteId.empty() || !parsed.machineLabel.empty();
  const bool allProvisioningValues =
    !parsed.deviceId.empty() && !parsed.siteId.empty() && !parsed.machineLabel.empty();
  if (anyProvisioningValue && !allProvisioningValues) {
    return false;
  }

  snapshot = parsed;
  return true;
}

PersistedStateLoadAction decidePersistedStateLoadAction(
  bool filesystemReady,
  bool primaryValid,
  bool backupValid
) {
  if (!filesystemReady) {
    return PersistedStateLoadAction::SkipFilesystem;
  }
  if (primaryValid) {
    return PersistedStateLoadAction::UsePrimary;
  }
  if (backupValid) {
    return PersistedStateLoadAction::UseBackup;
  }
  return PersistedStateLoadAction::InitializeDefaults;
}

}  // namespace firmware_runtime
