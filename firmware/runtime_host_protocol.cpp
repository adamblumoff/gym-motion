#include "runtime_host_protocol.hpp"
#include "json_object_reader.hpp"

namespace firmware_runtime {
namespace {

bool sessionTokenMatches(
  const std::string& activeSessionId,
  const std::string& sessionToken,
  bool emptyTokenMatches
) {
  if (sessionToken.empty()) {
    return emptyTokenMatches;
  }

  if (sessionToken.length() == 8) {
    return activeSessionId.compare(0, sessionToken.length(), sessionToken) == 0;
  }

  return activeSessionId == sessionToken;
}

}  // namespace

AppSessionState createResetAppSessionState(unsigned long defaultLeaseTimeoutMs) {
  AppSessionState state;
  state.appSessionLeaseTimeoutMs = defaultLeaseTimeoutMs;
  return state;
}

bool armBootstrapWatchdog(AppSessionState& state) {
  if (!state.runtimeBleConnected ||
      state.runtimeAppSessionConnected ||
      state.runtimeBootstrapLeasePending) {
    return false;
  }

  state.runtimeBootstrapLeasePending = true;
  return true;
}

void disarmBootstrapWatchdog(AppSessionState& state) {
  state.runtimeBootstrapLeasePending = false;
}

SessionOnlineUpdate markAppSessionOnline(
  AppSessionState& state,
  const std::string& sessionId,
  const std::string& sessionNonce,
  unsigned long expiresInMs,
  unsigned long timestamp,
  unsigned long defaultLeaseTimeoutMs
) {
  const unsigned long nextTimeout =
    expiresInMs > 0 ? expiresInMs : defaultLeaseTimeoutMs;
  const bool sessionChanged =
    !state.runtimeAppSessionConnected ||
    state.runtimeAppSessionId != sessionId ||
    state.runtimeAppSessionNonce != sessionNonce;

  state.runtimeAppSessionConnected = true;
  state.runtimeAppSessionId = sessionId;
  state.runtimeAppSessionNonce = sessionNonce;
  state.lastAppSessionLeaseAt = timestamp;
  state.lastRuntimeControlAt = timestamp;
  state.appSessionLeaseTimeoutMs = nextTimeout;
  state.runtimeBootstrapLeasePending = false;

  SessionOnlineUpdate update;
  update.sessionChanged = sessionChanged;
  update.nextTimeoutMs = nextTimeout;
  return update;
}

LeaseEnforcementResult evaluateAppSessionLease(
  const AppSessionState& state,
  unsigned long now,
  unsigned long bootstrapTimeoutMs
) {
  if (state.runtimeBootstrapLeasePending) {
    if (!state.runtimeBleConnected) {
      return {};
    }

    if (state.runtimeBleConnectedAt > 0 &&
        now - state.runtimeBleConnectedAt >= bootstrapTimeoutMs) {
      LeaseEnforcementResult result;
      result.kind = LeaseEnforcementResultKind::BootstrapTimedOut;
      result.shouldDisconnect = true;
      result.shouldRestartAdvertising = true;
      result.shouldResetSession = true;
      return result;
    }

    return {};
  }

  if (!state.runtimeAppSessionConnected || state.lastAppSessionLeaseAt == 0) {
    return {};
  }

  if (now - state.lastAppSessionLeaseAt < state.appSessionLeaseTimeoutMs) {
    return {};
  }

  LeaseEnforcementResult result;
  result.kind = LeaseEnforcementResultKind::LeaseExpired;
  result.shouldDisconnect = state.runtimeBleConnected;
  result.shouldRestartAdvertising = true;
  return result;
}

ControlCommand parseRuntimeControlCommand(
  const std::string& payload,
  unsigned long defaultLeaseTimeoutMs
) {
  ControlCommand command;
  json::ObjectReader reader(payload);
  if (!reader.isObject()) {
    return command;
  }

  std::string type;
  if (!reader.readString("type", type)) {
    return command;
  }

  if (type == "app-session-begin") {
    command.type = ControlCommandType::AppSessionBegin;
    reader.readString("sessionId", command.sessionId);
    reader.readString("sessionNonce", command.sessionNonce);
    command.expiresInMs = reader.readUnsignedLong("expiresInMs", defaultLeaseTimeoutMs);
    return command;
  }

  if (type == "app-session-lease") {
    command.type = ControlCommandType::AppSessionLease;
    reader.readString("sessionId", command.sessionId);
    command.expiresInMs = reader.readUnsignedLong("expiresInMs", defaultLeaseTimeoutMs);
    return command;
  }

  if (type == "app-session-end") {
    command.type = ControlCommandType::AppSessionEnd;
    reader.readString("sessionId", command.sessionId);
    return command;
  }

  if (type == "sync-now") {
    command.type = ControlCommandType::SyncNow;
    return command;
  }

  if (type == "ota-begin") {
    command.type = ControlCommandType::OtaBegin;
    return command;
  }

  if (type == "ota-end") {
    command.type = ControlCommandType::OtaEnd;
    return command;
  }

  if (type == "ota-abort") {
    command.type = ControlCommandType::OtaAbort;
    return command;
  }

  return command;
}

bool canApplyAppSessionLease(
  const AppSessionState& state,
  const ControlCommand& command
) {
  return command.type == ControlCommandType::AppSessionLease &&
    state.runtimeAppSessionConnected &&
    !state.runtimeAppSessionId.empty() &&
    !state.runtimeAppSessionNonce.empty() &&
    sessionTokenMatches(state.runtimeAppSessionId, command.sessionId, false);
}

bool canApplyAppSessionEnd(
  const AppSessionState& state,
  const ControlCommand& command
) {
  return command.type == ControlCommandType::AppSessionEnd &&
    state.runtimeAppSessionConnected &&
    !state.runtimeAppSessionId.empty() &&
    sessionTokenMatches(state.runtimeAppSessionId, command.sessionId, true);
}

}  // namespace firmware_runtime
