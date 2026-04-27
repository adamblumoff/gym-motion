#pragma once

#include <cstddef>
#include <string>

namespace firmware_runtime {

enum class ControlCommandType {
  Unknown,
  AppSessionBegin,
  AppSessionLease,
  AppSessionEnd,
  SyncNow,
  OtaBegin,
  OtaEnd,
  OtaAbort,
};

enum class LeaseEnforcementResultKind {
  None,
  BootstrapTimedOut,
  LeaseExpired,
};

struct AppSessionState {
  bool runtimeBleConnected = false;
  bool runtimeAppSessionConnected = false;
  bool runtimeBootstrapLeasePending = false;
  unsigned long runtimeBleConnectedAt = 0;
  unsigned long lastAppSessionLeaseAt = 0;
  unsigned long lastRuntimeControlAt = 0;
  unsigned long appSessionLeaseTimeoutMs = 0;
  std::string runtimeAppSessionId;
  std::string runtimeAppSessionNonce;
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
bool canApplyAppSessionLease(
  const AppSessionState& state,
  const ControlCommand& command
);
bool canApplyAppSessionEnd(
  const AppSessionState& state,
  const ControlCommand& command
);

}  // namespace firmware_runtime
