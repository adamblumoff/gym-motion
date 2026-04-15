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

  SUBCASE("active lease still healthy") {
    state.runtimeAppSessionConnected = true;
    state.lastAppSessionLeaseAt = 1'000;
    state.appSessionLeaseTimeoutMs = 15'000;
    const auto result = evaluateAppSessionLease(state, 10'000, 12'000);
    CHECK(result.kind == LeaseEnforcementResultKind::None);
  }

  SUBCASE("expired lease") {
    state.runtimeAppSessionConnected = true;
    state.lastAppSessionLeaseAt = 1'000;
    state.appSessionLeaseTimeoutMs = 5'000;
    const auto result = evaluateAppSessionLease(state, 7'000, 12'000);
    CHECK(result.kind == LeaseEnforcementResultKind::LeaseExpired);
    CHECK(result.shouldDisconnect);
    CHECK_FALSE(result.shouldResetSession);
  }
}

TEST_CASE("parseRuntimeControlCommand validates runtime session payload defaults") {
  const auto begin = parseRuntimeControlCommand(
    R"({"type":"app-session-begin","sessionId":"session-1","sessionNonce":"nonce-1"})",
    15'000
  );
  CHECK(begin.type == ControlCommandType::AppSessionBegin);
  CHECK(begin.sessionId == "session-1");
  CHECK(begin.sessionNonce == "nonce-1");
  CHECK(begin.expiresInMs == 15'000);

  const auto lease = parseRuntimeControlCommand(
    R"({"type":"app-session-lease","sessionId":"session-1"})",
    15'000
  );
  CHECK(lease.type == ControlCommandType::AppSessionLease);
  CHECK(lease.sessionId == "session-1");
  CHECK(lease.expiresInMs == 15'000);

  const auto end = parseRuntimeControlCommand(
    R"({"type":"app-session-end","sessionId":"session-1"})",
    15'000
  );
  CHECK(end.type == ControlCommandType::AppSessionEnd);
  CHECK(end.sessionId == "session-1");
  CHECK(end.expiresInMs == 0);
}
