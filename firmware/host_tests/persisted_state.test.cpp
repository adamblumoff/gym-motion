#include "../third_party/doctest/doctest.h"

#include "../persisted_state.hpp"

using namespace firmware_runtime;

TEST_CASE("parsePersistedStatePayload accepts a fully populated snapshot") {
  PersistedStateSnapshot snapshot;
  const bool parsed = parsePersistedStatePayload(
    R"({"device_id":"node-1","site_id":"gym-a","machine_label":"Leg Press","next_seq":42,"acked_seq":17,"hist_ovf":1,"hist_drop":3})",
    snapshot
  );

  CHECK(parsed);
  CHECK(snapshot.deviceId == "node-1");
  CHECK(snapshot.siteId == "gym-a");
  CHECK(snapshot.machineLabel == "Leg Press");
  CHECK(snapshot.nextHistorySequence == 42);
  CHECK(snapshot.ackedHistorySequence == 17);
  CHECK(snapshot.historyOverflowed);
  CHECK(snapshot.historyDroppedCount == 3);
}

TEST_CASE("parsePersistedStatePayload rejects malformed or partial snapshots") {
  PersistedStateSnapshot snapshot;

  CHECK_FALSE(parsePersistedStatePayload("{}", snapshot));
  CHECK_FALSE(parsePersistedStatePayload(
    R"({"device_id":"node-1","site_id":"","machine_label":"Leg Press","next_seq":42,"acked_seq":17,"hist_ovf":0,"hist_drop":0})",
    snapshot
  ));
  CHECK_FALSE(parsePersistedStatePayload(
    R"({"device_id":"","site_id":"","machine_label":"","next_seq":17,"acked_seq":17,"hist_ovf":0,"hist_drop":0})",
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
