#pragma once

#include <cstddef>
#include <string>

namespace firmware_runtime {

enum class ControlCommandType {
  Unknown,
  AppSessionBootstrap,
  AppSessionLease,
  SyncNow,
  OtaBegin,
  OtaEnd,
  OtaAbort,
};

enum class HistoryControlCommandType {
  Unknown,
  HistoryPageRequest,
  HistoryPageAck,
};

enum class LeaseEnforcementResultKind {
  None,
  BootstrapTimedOut,
  MissingLeaseTimedOut,
  LeaseExpired,
};

struct AppSessionState {
  bool runtimeBleConnected = false;
  bool runtimeAppSessionConnected = false;
  bool runtimeBootstrapLeasePending = false;
  bool runtimeLeaseRequired = false;
  unsigned long runtimeBleConnectedAt = 0;
  unsigned long lastAppSessionLeaseAt = 0;
  unsigned long lastRuntimeControlAt = 0;
  unsigned long appSessionLeaseTimeoutMs = 0;
  std::string runtimeAppSessionId;
  std::string runtimeAppSessionNonce;
  std::string runtimeBootstrapSessionNonce;
};

struct SessionOnlineUpdate {
  bool sessionChanged = false;
  unsigned long nextTimeoutMs = 0;
};

struct LeaseEnforcementResult {
  LeaseEnforcementResultKind kind = LeaseEnforcementResultKind::None;
  bool shouldDisconnect = false;
  bool shouldRestartAdvertising = false;
  bool shouldResetSession = false;
};

struct ControlCommand {
  ControlCommandType type = ControlCommandType::Unknown;
  std::string sessionId;
  std::string sessionNonce;
  unsigned long expiresInMs = 0;
};

struct HistorySyncState {
  unsigned long nextSequence = 1;
  unsigned long ackedSequence = 0;
  bool overflowed = false;
  unsigned long droppedCount = 0;
};

struct HistoryAckResult {
  bool advanced = false;
  bool clearedOverflow = false;
};

struct HistoryControlCommand {
  HistoryControlCommandType type = HistoryControlCommandType::Unknown;
  std::string sessionId;
  std::string requestId;
  unsigned long afterSequence = 0;
  std::size_t maxRecords = 0;
  unsigned long sequence = 0;
};

struct HistorySyncRequest {
  std::string sessionId;
  std::string requestId;
  unsigned long afterSequence = 0;
  std::size_t maxRecords = 0;
};

struct HistoryAckRequest {
  std::string sessionId;
  std::string requestId;
  unsigned long sequence = 0;
};

AppSessionState createResetAppSessionState(unsigned long defaultLeaseTimeoutMs);
bool armBootstrapWatchdog(AppSessionState& state);
void disarmBootstrapWatchdog(AppSessionState& state);
SessionOnlineUpdate markAppSessionOnline(
  AppSessionState& state,
  const std::string& sessionId,
  const std::string& sessionNonce,
  unsigned long expiresInMs,
  unsigned long timestamp,
  unsigned long defaultLeaseTimeoutMs
);
LeaseEnforcementResult evaluateAppSessionLease(
  const AppSessionState& state,
  unsigned long now,
  unsigned long bootstrapTimeoutMs
);
ControlCommand parseRuntimeControlCommand(
  const std::string& payload,
  unsigned long defaultLeaseTimeoutMs
);
HistoryControlCommand parseHistoryControlCommand(
  const std::string& payload,
  std::size_t defaultHistoryPageSize
);
unsigned long allocateHistorySequence(HistorySyncState& state);
HistoryAckResult acknowledgeHistoryThrough(HistorySyncState& state, unsigned long sequence);
HistorySyncRequest createHistorySyncRequest(
  const HistoryControlCommand& command,
  std::size_t defaultHistoryPageSize
);
HistoryAckRequest createHistoryAckRequest(const HistoryControlCommand& command);

}  // namespace firmware_runtime
