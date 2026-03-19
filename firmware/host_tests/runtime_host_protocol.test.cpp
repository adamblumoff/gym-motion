#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "../third_party/doctest/doctest.h"

#include "../runtime_host_protocol.hpp"

using namespace firmware_runtime;

TEST_CASE("bootstrap watchdog only arms for connected runtime sessions") {
  AppSessionState state = createResetAppSessionState(15'000);

  CHECK_FALSE(armBootstrapWatchdog(state));

  state.runtimeBleConnected = true;
  CHECK(armBootstrapWatchdog(state));
  CHECK(state.runtimeBootstrapLeasePending);
  CHECK_FALSE(armBootstrapWatchdog(state));

  disarmBootstrapWatchdog(state);
  CHECK_FALSE(state.runtimeBootstrapLeasePending);
}

TEST_CASE("markAppSessionOnline distinguishes refreshes from new sessions") {
  AppSessionState state = createResetAppSessionState(15'000);
  state.runtimeBleConnected = true;

  const auto firstUpdate =
    markAppSessionOnline(state, "session-1", "nonce-1", 5'000, 100, 15'000);
  CHECK(firstUpdate.sessionChanged);
  CHECK(state.runtimeAppSessionConnected);
  CHECK(state.runtimeAppSessionId == "session-1");
  CHECK(state.runtimeAppSessionNonce == "nonce-1");
  CHECK(state.appSessionLeaseTimeoutMs == 5'000);

  const auto refreshUpdate =
    markAppSessionOnline(state, "session-1", "nonce-1", 0, 250, 15'000);
  CHECK_FALSE(refreshUpdate.sessionChanged);
  CHECK(state.lastAppSessionLeaseAt == 250);
  CHECK(state.appSessionLeaseTimeoutMs == 15'000);
}

TEST_CASE("evaluateAppSessionLease reports bootstrap and lease expiry regressions") {
  AppSessionState state = createResetAppSessionState(15'000);
  state.runtimeBleConnected = true;
  state.runtimeBleConnectedAt = 100;

  SUBCASE("bootstrap timeout") {
    state.runtimeBootstrapLeasePending = true;
    const auto result = evaluateAppSessionLease(state, 12'200, 12'000);
    CHECK(result.kind == LeaseEnforcementResultKind::BootstrapTimedOut);
    CHECK(result.shouldDisconnect);
    CHECK(result.shouldRestartAdvertising);
    CHECK(result.shouldResetSession);
  }

  SUBCASE("missing lease timeout after bootstrap") {
    state.runtimeLeaseRequired = true;
    const auto result = evaluateAppSessionLease(state, 12'200, 12'000);
    CHECK(result.kind == LeaseEnforcementResultKind::MissingLeaseTimedOut);
    CHECK(result.shouldDisconnect);
  }

  SUBCASE("active lease still healthy") {
    state.runtimeLeaseRequired = true;
    state.runtimeAppSessionConnected = true;
    state.lastAppSessionLeaseAt = 1'000;
    state.appSessionLeaseTimeoutMs = 15'000;
    const auto result = evaluateAppSessionLease(state, 10'000, 12'000);
    CHECK(result.kind == LeaseEnforcementResultKind::None);
  }

  SUBCASE("expired lease") {
    state.runtimeLeaseRequired = true;
    state.runtimeAppSessionConnected = true;
    state.lastAppSessionLeaseAt = 1'000;
    state.appSessionLeaseTimeoutMs = 5'000;
    const auto result = evaluateAppSessionLease(state, 7'000, 12'000);
    CHECK(result.kind == LeaseEnforcementResultKind::LeaseExpired);
    CHECK(result.shouldDisconnect);
    CHECK_FALSE(result.shouldResetSession);
  }
}

TEST_CASE("parseRuntimeControlCommand validates session and history payload defaults") {
  const auto bootstrap = parseRuntimeControlCommand(
    R"({"type":"app-session-bootstrap","sessionNonce":"nonce-1"})",
    15'000,
    80
  );
  CHECK(bootstrap.type == ControlCommandType::AppSessionBootstrap);
  CHECK(bootstrap.sessionNonce == "nonce-1");

  const auto lease = parseRuntimeControlCommand(
    R"({"type":"app-session-lease","sessionId":"session-1"})",
    15'000,
    80
  );
  CHECK(lease.type == ControlCommandType::AppSessionLease);
  CHECK(lease.sessionId == "session-1");
  CHECK(lease.expiresInMs == 15'000);

  const auto historySync = parseRuntimeControlCommand(
    R"({"type":"history-sync-begin","afterSequence":12,"maxRecords":0})",
    15'000,
    80
  );
  const auto syncRequest = createHistorySyncRequest(historySync, 80);
  CHECK(historySync.type == ControlCommandType::HistorySyncBegin);
  CHECK(syncRequest.afterSequence == 12);
  CHECK(syncRequest.maxRecords == 80);

  const auto historyAck = parseRuntimeControlCommand(
    R"({"type":"history-ack","sequence":99})",
    15'000,
    80
  );
  CHECK(historyAck.type == ControlCommandType::HistoryAck);
  CHECK(historyAck.sequence == 99);
}

TEST_CASE("history helpers advance sequence and clear overflow after ack") {
  HistorySyncState state;
  state.nextSequence = 41;
  state.ackedSequence = 10;
  state.overflowed = true;
  state.droppedCount = 3;

  const auto nextSequence = allocateHistorySequence(state);
  CHECK(nextSequence == 41);
  CHECK(state.nextSequence == 42);

  const auto noOpAck = acknowledgeHistoryThrough(state, 9);
  CHECK_FALSE(noOpAck.advanced);
  CHECK(state.ackedSequence == 10);
  CHECK(state.overflowed);

  const auto appliedAck = acknowledgeHistoryThrough(state, 42);
  CHECK(appliedAck.advanced);
  CHECK(appliedAck.clearedOverflow);
  CHECK(state.ackedSequence == 42);
  CHECK_FALSE(state.overflowed);
  CHECK(state.droppedCount == 0);
}
