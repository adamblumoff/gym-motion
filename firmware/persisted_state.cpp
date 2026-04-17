#include "persisted_state.hpp"
#include "json_object_reader.hpp"

namespace firmware_runtime {

namespace {

}  // namespace

bool parsePersistedStatePayload(
  const std::string& payload,
  PersistedStateSnapshot& snapshot
) {
  json::ObjectReader reader(payload);
  if (!reader.isObject()) {
    return false;
  }

  const char* requiredKeys[] = {
    "device_id",
    "site_id",
    "machine_label",
  };

  for (const char* key : requiredKeys) {
    if (!reader.hasKey(key)) {
      return false;
    }
  }

  PersistedStateSnapshot parsed;
  if (!reader.readString("device_id", parsed.deviceId) ||
      !reader.readString("site_id", parsed.siteId) ||
      !reader.readString("machine_label", parsed.machineLabel)) {
    return false;
  }

  const bool anyProvisioningValue =
    !parsed.deviceId.empty() || !parsed.siteId.empty() || !parsed.machineLabel.empty();
  const bool allProvisioningValues =
    !parsed.deviceId.empty() && !parsed.siteId.empty() && !parsed.machineLabel.empty();
  if (!anyProvisioningValue || !allProvisioningValues) {
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
