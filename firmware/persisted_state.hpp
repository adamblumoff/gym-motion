#pragma once

#include <string>

namespace firmware_runtime {

struct PersistedStateSnapshot {
  std::string deviceId;
  std::string siteId;
  std::string machineLabel;
  unsigned long nextHistorySequence = 1;
  unsigned long ackedHistorySequence = 0;
  bool historyOverflowed = false;
  unsigned long historyDroppedCount = 0;
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
