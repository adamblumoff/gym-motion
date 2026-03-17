# Windows Movement Analytics Vision

read_when: you are restarting movement analytics work, redesigning Windows history sync, or deciding how reconnect, live motion, cache, and canonical history should fit together.

Related:
- [docs/desktop-architecture.md](/home/adamblumoff/gym-motion/docs/desktop-architecture.md)
- [docs/desktop-code-map.md](/home/adamblumoff/gym-motion/docs/desktop-code-map.md)
- [docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md)

## Why This Exists

The `feat/movement-analytics` branch captured a lot of useful product thinking, but the implementation drifted away from the intended flow and destabilized reconnects. This document preserves the product contract and the lessons we paid to learn so the next rebuild can start cleanly.

This vision is reconstructed from:
- the original Codex planning and decision session for this branch
- the branch docs and early analytics/history-sync commits

## Product Goal

Build a Windows-only movement analytics flow that feels instant to the operator, preserves movement history reliably, and never lets history sync destabilize the live Bluetooth session.

The operator experience should feel like this:
- the dashboard stays live-stream first
- analytics is per-device only in v1
- cached analytics opens fast
- reconnect happens first
- history catch-up happens after reconnect, in the background
- live motion stays visible while canonical history catches up

## Core Decisions

### Analytics scope

- Canonical analytics is movement-first.
- Per-device analytics is the only v1 mode. No compare mode yet.
- The first user-facing windows are `24h` and `7d`.
- The main chart should show movement counts and duration buckets over time.
- Connection and disconnection spans are not the core analytics product. They can exist as debug or supporting visibility, but they should not dominate the analytics model.

### Data truth

- Postgres is the canonical source of truth for long-term analytics.
- The desktop app keeps a persisted local analytics cache so reopen is fast.
- Live runtime telemetry is provisional and should be layered on top of cached or canonical history.
- Backfilled history must not overwrite the current live movement summary once the node has recent live contact.

### History retention and firmware intent

- The node should prefer low power over always-on Bluetooth.
- The node should keep durable movement history locally until the Windows app catches up.
- Firmware compaction should favor movement retention over low-value connection detail.
- Movement history can be compacted into efficient spans or summaries, as long as backend reconstruction can still place it correctly on the chart.
- Compaction or storage pressure should surface as an analytics-visible warning, not silently disappear.

### Windows reconnect and sync flow

- Reconnect and history replay are two separate phases.
- The session must become truly connected and leased before any history replay starts.
- History replay is a post-connect background task, never part of handshake success.
- History sync failure must not be treated as connection failure.
- A healthy live session is more important than immediate history catch-up.

## Desired Operator Flow

### Dashboard

- The dashboard is the live surface.
- Live stream responsiveness comes first.
- Analytics loading work must not make the dashboard feel blocked or unstable.

### Analytics page

- The analytics page uses a loading skeleton only when there is no cached or canonical data yet.
- If cached analytics exists, show it immediately.
- If catch-up is running, keep cached analytics visible and show a page-level loading or syncing banner.
- Connected nodes should sort first in the analytics picker.
- Reconnecting or disconnected nodes should not be presented as normal active analytics targets.
- Once a node is connected, previous history can appear immediately from cache while background sync catches up.

### Sync order

- On reconnect, establish the live session first.
- After the live session is healthy, start history replay.
- Replay should prioritize newest data first, then older backlog.
- Sync should resume from the last acknowledged boundary instead of replaying everything blindly.

## Architecture Boundaries

- The Windows sidecar owns BLE scan, reconnect, handshake, and transport truth.
- Firmware owns app-session lease truth and local history durability.
- The runtime server projects state and persists data; it does not invent BLE truth.
- Electron main owns persistence, lifecycle, and sequencing.
- The renderer presents state; it should not be the place where analytics truth is derived.

## Non-Negotiable Rebuild Rules

- Do not let history sync participate in reconnect success criteria.
- Do not let history-sync failure demote a connected node into disconnected or reconnecting state by itself.
- Do not let live motion disappear just because canonical replay is running.
- Do not let replay advancement race reconnect state transitions.
- Do not let analytics UI truth depend on half-connected or half-synced transport state.
- Do not use non-Windows behavior as the deciding product signal for a Windows-only desktop path.

## Common Pitfalls We Hit

- We tied reconnect and history replay together too early, so history behavior contaminated connection behavior.
- We allowed history-sync failure to cascade into live-session instability instead of containing it as a secondary problem.
- We treated transport ambiguity like a product failure instead of designing the replay protocol to be explicitly acknowledged and idempotent.
- We reused fragile control paths too aggressively, which made lease maintenance and replay compete for the same unstable session machinery.
- We let recovery complexity inside the sidecar start defining the product behavior, instead of preserving the simpler reconnect-first product contract.
- We allowed analytics availability to follow reconnecting or stale runtime state too closely, which made selection and loading behavior confusing.
- We risked letting backfilled history overwrite current live movement state, which breaks operator trust.
- We changed protocol behavior without making firmware versioning obvious enough, which made bench verification ambiguous.
- We spent effort validating through Linux or bench-oriented paths even though the active product runtime is Windows-only.

## Acceptance Criteria For A Clean Rebuild

- The Windows app reliably reconnects to an approved node without history replay being part of handshake success.
- After reconnect, live motion remains stable even if history replay is delayed, paused, or fails.
- Analytics opens quickly from cache when available.
- History catch-up runs after connection and updates canonical analytics without flicker or selection churn.
- The analytics picker and page state reflect the product contract: live-first, connected-first, movement-first.
- Storage pressure, compaction, and incomplete history are visible to the operator in analytics without destabilizing the live runtime.

## What This Document Is Not

- It is not approval to reuse the implementation from `feat/movement-analytics`.
- It is not a detailed protocol spec.
- It is not a promise that connection history belongs in the main analytics experience.

The next implementation should treat this document as the product and architecture contract, then design the protocol and code to satisfy it cleanly.
