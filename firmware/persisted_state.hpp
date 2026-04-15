#pragma once

#include <string>

namespace firmware_runtime {

struct PersistedStateSnapshot {
  std::string deviceId;
  std::string siteId;
  std::string machineLabel;
};

enum class PersistedStateLoadAction {
  SkipFilesystem,
  UsePrimary,
  UseBackup,
  InitializeDefaults,
};

bool parsePersistedStatePayload(
  const std::string& payload,
  PersistedStateSnapshot& snapshot
);

PersistedStateLoadAction decidePersistedStateLoadAction(
  bool filesystemReady,
  bool primaryValid,
  bool backupValid
);

}  // namespace firmware_runtime
