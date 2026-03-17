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

## Current Implementation Boundary

- Canonical movement buckets are currently computed from stored `motion_events` using `received_at` time on the gateway/backend side.
- The renderer does not compute canonical history from raw snapshot events anymore.
- The renderer may still build a short live provisional overlay from snapshot movement events for the current tail.
- The Windows runtime now requests firmware history pages from the sidecar after a session becomes healthy, persists each page through child-process IPC, and only then acks firmware compaction.
- Firmware archive replay still reuses raw motion history rows today; compact boot-session span archival is still a future firmware-format improvement rather than a desktop/runtime gap.

## Desktop Cache

- The desktop cache is stored locally in preferences under the movement analytics cache key.
- Cache currently persists the canonical `24h` and `7d` windows per device.
- Cache should be invalidated whenever newer canonical movement history lands or the cache schema changes.

## Page Behavior

- If a device has cached canonical analytics, show it immediately and refresh in the background.
- If a device has no canonical analytics yet, the page can show a live provisional chart while history is being built.
- Sync problems and compaction/storage-pressure notices belong on the analytics page, not the dashboard.
- Storage-pressure notices can come from either persisted compaction logs or `device_sync_state.last_overflow_detected_at` when the firmware reported overflow during replay.
