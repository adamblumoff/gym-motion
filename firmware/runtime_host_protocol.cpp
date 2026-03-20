#include "runtime_host_protocol.hpp"

#include <cctype>
#include <cstdlib>

namespace firmware_runtime {
namespace {

std::string extractJsonString(const std::string& json, const char* key) {
  const std::string token = "\"" + std::string(key) + "\":\"";
  const std::size_t start = json.find(token);

  if (start == std::string::npos) {
    return "";
  }

  const std::size_t valueStart = start + token.size();
  std::size_t valueEnd = valueStart;

  while (valueEnd < json.size()) {
    if (json[valueEnd] == '"' && (valueEnd == valueStart || json[valueEnd - 1] != '\\')) {
      break;
    }

    valueEnd += 1;
  }

  std::string value = json.substr(valueStart, valueEnd - valueStart);

  std::size_t replaceAt = value.find("\\/");
  while (replaceAt != std::string::npos) {
    value.replace(replaceAt, 2, "/");
    replaceAt = value.find("\\/", replaceAt + 1);
  }

  replaceAt = value.find("\\\"");
  while (replaceAt != std::string::npos) {
    value.replace(replaceAt, 2, "\"");
    replaceAt = value.find("\\\"", replaceAt + 1);
  }

  return value;
}

std::size_t extractJsonSize(const std::string& json, const char* key, std::size_t fallback) {
  const std::string token = "\"" + std::string(key) + "\":";
  const std::size_t start = json.find(token);

  if (start == std::string::npos) {
    return fallback;
  }

  std::size_t valueStart = start + token.size();
  while (valueStart < json.size() && std::isspace(static_cast<unsigned char>(json[valueStart]))) {
    valueStart += 1;
  }

  std::size_t valueEnd = valueStart;
  while (valueEnd < json.size() && std::isdigit(static_cast<unsigned char>(json[valueEnd]))) {
    valueEnd += 1;
  }

  if (valueEnd == valueStart) {
    return fallback;
  }

  return static_cast<std::size_t>(
    std::strtoull(json.substr(valueStart, valueEnd - valueStart).c_str(), nullptr, 10)
  );
}

unsigned long extractJsonUnsignedLong(
  const std::string& json,
  const char* key,
  unsigned long fallback
) {
  return static_cast<unsigned long>(extractJsonSize(json, key, fallback));
}

}  // namespace

AppSessionState createResetAppSessionState(unsigned long defaultLeaseTimeoutMs) {
  AppSessionState state;
  state.appSessionLeaseTimeoutMs = defaultLeaseTimeoutMs;
  return state;
}

bool armBootstrapWatchdog(AppSessionState& state) {
  if (!state.runtimeBleConnected ||
      state.runtimeLeaseRequired ||
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
  state.runtimeBootstrapSessionNonce = sessionNonce;

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
  if (!state.runtimeBleConnected) {
    return {};
  }

  if (state.runtimeBootstrapLeasePending) {
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

  if (!state.runtimeLeaseRequired) {
    return {};
  }

  if (!state.runtimeAppSessionConnected || state.lastAppSessionLeaseAt == 0) {
    if (state.runtimeBleConnectedAt > 0 &&
        now - state.runtimeBleConnectedAt >= bootstrapTimeoutMs) {
      LeaseEnforcementResult result;
      result.kind = LeaseEnforcementResultKind::MissingLeaseTimedOut;
      result.shouldDisconnect = true;
      result.shouldRestartAdvertising = true;
      result.shouldResetSession = true;
      return result;
    }

    return {};
  }

  if (now - state.lastAppSessionLeaseAt < state.appSessionLeaseTimeoutMs) {
    return {};
  }

  LeaseEnforcementResult result;
  result.kind = LeaseEnforcementResultKind::LeaseExpired;
  result.shouldDisconnect = true;
  result.shouldRestartAdvertising = true;
  return result;
}

ControlCommand parseRuntimeControlCommand(
  const std::string& payload,
  unsigned long defaultLeaseTimeoutMs,
  std::size_t defaultHistoryPageSize
) {
  ControlCommand command;
  const std::string type = extractJsonString(payload, "type");

  if (type == "app-session-bootstrap") {
    command.type = ControlCommandType::AppSessionBootstrap;
    command.sessionNonce = extractJsonString(payload, "sessionNonce");
    return command;
  }

  if (type == "app-session-lease") {
    command.type = ControlCommandType::AppSessionLease;
    command.sessionId = extractJsonString(payload, "sessionId");
    command.expiresInMs =
      extractJsonUnsignedLong(payload, "expiresInMs", defaultLeaseTimeoutMs);
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

  if (type == "history-sync-begin") {
    command.type = ControlCommandType::HistorySyncBegin;
    command.afterSequence = extractJsonUnsignedLong(payload, "afterSequence", 0);
    command.maxRecords =
      extractJsonSize(payload, "maxRecords", defaultHistoryPageSize);
    return command;
  }

  if (type == "history-ack") {
    command.type = ControlCommandType::HistoryAck;
    command.sequence = extractJsonUnsignedLong(payload, "sequence", 0);
    return command;
  }

  return command;
}

unsigned long allocateHistorySequence(HistorySyncState& state) {
  const unsigned long sequence = state.nextSequence;
  state.nextSequence += 1;
  return sequence;
}

HistoryAckResult acknowledgeHistoryThrough(HistorySyncState& state, unsigned long sequence) {
  if (sequence <= state.ackedSequence) {
    return {};
  }

  state.ackedSequence = sequence;
  const bool clearedOverflow = state.overflowed;
  if (state.overflowed) {
    state.overflowed = false;
    state.droppedCount = 0;
  }

  HistoryAckResult result;
  result.advanced = true;
  result.clearedOverflow = clearedOverflow;
  return result;
}

HistorySyncRequest createHistorySyncRequest(
  const ControlCommand& command,
  std::size_t defaultHistoryPageSize
) {
  HistorySyncRequest request;
  request.afterSequence = command.afterSequence;
  request.maxRecords =
    command.maxRecords > 0 ? command.maxRecords : defaultHistoryPageSize;
  return request;
}

}  // namespace firmware_runtime
