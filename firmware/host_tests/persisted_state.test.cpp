#include "../third_party/doctest/doctest.h"

#include "../persisted_state.hpp"

using namespace firmware_runtime;

TEST_CASE("parsePersistedStatePayload accepts a fully populated snapshot") {
  PersistedStateSnapshot snapshot;
  const bool parsed = parsePersistedStatePayload(
    R"({"device_id":"node-1","site_id":"gym-a","machine_label":"Leg Press"})",
    snapshot
  );

  CHECK(parsed);
  CHECK(snapshot.deviceId == "node-1");
  CHECK(snapshot.siteId == "gym-a");
  CHECK(snapshot.machineLabel == "Leg Press");
}

TEST_CASE("parsePersistedStatePayload accepts whitespace and escaped characters") {
  PersistedStateSnapshot snapshot;
  const bool parsed = parsePersistedStatePayload(
    "{\n"
    "  \"machine_label\" : \"Leg \\\"Press\\\"\",\n"
    "  \"site_id\" : \"gym\\/a\",\n"
    "  \"device_id\" : \"node-1\"\n"
    "}",
    snapshot
  );

  CHECK(parsed);
  CHECK(snapshot.deviceId == "node-1");
  CHECK(snapshot.siteId == "gym/a");
  CHECK(snapshot.machineLabel == "Leg \"Press\"");
}

TEST_CASE("parsePersistedStatePayload rejects malformed or partial snapshots") {
  PersistedStateSnapshot snapshot;

  CHECK_FALSE(parsePersistedStatePayload("{}", snapshot));
  CHECK_FALSE(parsePersistedStatePayload(
    R"({"device_id":"node-1","site_id":"","machine_label":"Leg Press"})",
    snapshot
  ));
  CHECK_FALSE(parsePersistedStatePayload(
    R"({"device_id":"","site_id":"","machine_label":""})",
    snapshot
  ));
  CHECK_FALSE(parsePersistedStatePayload(
    R"({"device_id":"node-1","site_id":"gym-a","machine_label":42})",
    snapshot
  ));
  CHECK_FALSE(parsePersistedStatePayload(
    R"({"device_id":"node-1","site_id":"gym-a","machine_label":"Leg Press")",
    snapshot
  ));
}

TEST_CASE("decidePersistedStateLoadAction preserves state on mount failure") {
  CHECK(
    decidePersistedStateLoadAction(false, false, false) ==
    PersistedStateLoadAction::SkipFilesystem
  );
  CHECK(
    decidePersistedStateLoadAction(true, true, true) ==
    PersistedStateLoadAction::UsePrimary
  );
  CHECK(
    decidePersistedStateLoadAction(true, false, true) ==
    PersistedStateLoadAction::UseBackup
  );
  CHECK(
    decidePersistedStateLoadAction(true, false, false) ==
    PersistedStateLoadAction::InitializeDefaults
  );
}
