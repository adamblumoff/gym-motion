# Movement Analytics

read_when: you are changing the analytics page, movement-history cache behavior, per-device analytics IPC, or the source-of-truth path for movement history.

Related:
- [docs/desktop-architecture.md](/home/adamblumoff/gym-motion/docs/desktop-architecture.md)
- [docs/desktop-code-map.md](/home/adamblumoff/gym-motion/docs/desktop-code-map.md)
- [docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md)

## Current Product Shape

- Canonical analytics is movement-only.
- Connection and runtime lifecycle detail is not part of normal analytics history.
- The analytics page is per-device only in v1.
- The first user-facing ranges are:
  - `24h`
  - `7d`

## Source Of Truth

- Postgres remains the source of truth for canonical movement history.
- The desktop app keeps a persisted local analytics cache for fast reopen.
- Live movement still comes from the runtime snapshot and is treated as provisional until canonical history catches up.
- Backfilled history is for canonical analytics only; once a node has recent live contact, replay must not overwrite the current live movement summary fields on the device row.

## Current Implementation Boundary

- Canonical movement buckets are currently computed from stored `motion_events` using `received_at` time on the gateway/backend side.
- The renderer does not compute canonical history from raw snapshot events anymore.
- The renderer may still build a short live provisional overlay from snapshot movement events for the current tail.
- The Windows runtime now treats reconnect and history replay as separate phases:
  - first the session must reach normal runtime `connected`
  - only after that does the child request firmware history pages
  - auto replay is delayed by one lease interval so a freshly reconnected session can prove the steady-state control path is healthy before replay begins
- Each history page is persisted through child-process IPC before firmware compaction is acked.
- After a page is persisted, replay advancement is serialized behind that ack. The gateway child must not fire a second `start_history_sync` in parallel with the ack for the page that just landed; the sidecar owns the "ack then next page" sequence on the live session.
- If replay hits a closed-handle WinRT control-path error, pause replay for that session immediately. Keep the node connected only if active-session recovery can reacquire the full runtime IO path; otherwise force a clean reconnect instead of pretending the live session is still healthy.
- Firmware archive replay still reuses raw motion history rows today; compact boot-session span archival is still a future firmware-format improvement rather than a desktop/runtime gap.

## Desktop Cache

- The desktop cache is stored locally in preferences under the movement analytics cache key.
- Cache currently persists the canonical `24h` and `7d` windows per device.
- Cache should be invalidated whenever newer canonical movement history lands or the cache schema changes.

## Page Behavior

- The Analytics dropdown can show approved devices even when they are disconnected or reconnecting; connected nodes should sort to the top.
- The selected device stays pinned even if it drops offline.
- Connection and replay state belongs on the Analytics page itself, not in dropdown eligibility.
- If a device has cached canonical analytics, show it immediately and refresh in the background.
- If history replay is already running, keep cached analytics visible and show a page-level loading banner until replay finishes.
- If a device has no canonical analytics yet, the page can show a loading skeleton while history is being built and still fall back to a live provisional chart when that is all we have.
- Sync problems and compaction/storage-pressure notices belong on the analytics page, not the dashboard.
- Storage-pressure notices can come from either persisted compaction logs or `device_sync_state.last_overflow_detected_at` when the firmware reported overflow during replay.
