# Development Environments

read_when: you are trying to work on the local app while real production devices still exist, or you need to decide how local, staging, and production should relate.

The current desktop product path is Windows-only. Environment decisions should assume the real operator flow is Windows desktop app + WinRT BLE sidecar + ESP32 firmware, even if parts of the repo still run elsewhere for development support.

## Problem

Right now local development can look confusing because there are three independent pieces:

- the web app code you are running locally
- the database the local app is connected to
- the API URL the ESP32 devices are posting to

If those are not all in the same environment, the app can feel "wrong" even when each piece is doing exactly what it was told to do.

Example:

- local app at `http://localhost:3000`
- local API routes
- production Railway database via `.env.local`
- production ESP32 devices posting to Railway production

That means the UI is local, some reads are from production data, and the devices themselves are still talking to production. This is workable for debugging, but it is easy to misread what is happening.

## Goals

We want a future setup that makes these things explicit:

- when we are looking at real production device data
- when we are working safely against a dev database
- when a physical device is intentionally pointed at something other than production
- how to debug production issues without accidentally changing production state

## Direction 1: Local App + Local DB + Dev Device

This is the cleanest software-development setup.

Shape:

- local app
- local Postgres or a dedicated Railway dev database
- one ESP32 configured to post to the local or dev app

Pros:

- safest day-to-day development setup
- UI changes and data changes stay in the same environment
- easiest to reason about bugs
- no chance of accidentally mutating production data during normal work

Cons:

- requires at least one device that is intentionally treated as a dev device
- does not help inspect live production devices directly
- harder to reproduce "real gym" issues unless you mirror production setup carefully

When to use:

- most feature work
- UI iteration
- schema changes
- firmware behavior testing before release

## Direction 2: Local App + Production DB + Production Devices

This is the mode we effectively had during debugging.

Shape:

- local app
- production Railway database
- production devices still posting to production API

Pros:

- useful for fast UI debugging against real data
- useful when you want to inspect current production state locally
- no need to re-point devices

Cons:

- very easy to confuse local UI bugs with production data issues
- local app can mutate production state through local API routes
- dangerous as a default workflow
- bad fit for schema experiments or destructive scripts

When to use:

- short, intentional debugging sessions only
- read-mostly production investigation

Recommendation:

- do not make this the default local mode
- add an obvious "connected to production data" banner if we keep using it

## Direction 3: Staging App + Staging DB + One Repointable Device

This is the most product-like pre-production workflow.

Shape:

- deployed staging app
- staging database
- one or a few ESP32 devices flashed or provisioned to hit staging

Pros:

- closest to real deployment behavior
- easiest place to test OTA, BLE provisioning flow dependencies, and long-running SSE behavior
- isolates production from experiments

Cons:

- extra environment to maintain
- requires deliberate device reconfiguration
- more operational overhead than pure local development

When to use:

- OTA rollout testing
- setup/provisioning flow validation
- release candidate checks
- "does this work like production?" questions

## Direction 4: Production App + Production DB + Production Devices, Plus Better Observability

This is not a dev environment, but it reduces the need to point local code at production.

Shape:

- production stays production
- debugging happens through:
  - `/logs`
  - richer device health views
  - structured remote logs
  - maybe admin/debug screens later

Pros:

- safest operationally
- avoids local/prod confusion
- best for investigating field issues without changing environment wiring

Cons:

- slower for UI iteration
- some bugs still need a local or staging repro

When to use:

- field debugging
- live incident investigation
- fleet health checks

## Recommended Near-Term Approach

Best practical next step:

1. Keep production as-is.
2. Introduce a dedicated dev or staging database.
3. Add one obvious environment indicator in the UI.
4. Keep one ESP32 that can be deliberately pointed at non-production for testing.

That gives us:

- safe local feature work
- a realistic place to test setup and OTA
- less temptation to use production as the default development backend

## Concrete Improvements We Could Add Later

### Option A: Environment banner in the UI

Add a small persistent badge in the shell like:

- `LOCAL`
- `STAGING`
- `PRODUCTION DATA`

Pros:

- cheap
- immediately reduces confusion

Cons:

- informational only; does not prevent mistakes

### Option B: Separate env files

Examples:

- `.env.local` for safe default local development
- `.env.production-debug` for intentional production-data inspection

Pros:

- simple
- explicit

Cons:

- still depends on human discipline

### Option C: Dedicated staging deployment

Pros:

- best end-to-end realism
- ideal for OTA and BLE setup work

Cons:

- more infrastructure to manage

### Option D: Device-level environment targeting

Make the ESP32 API base URL a configurable setting rather than something only changed in source.

Pros:

- easier to move one device between dev, staging, and prod
- useful for bench testing

Cons:

- adds another configuration dimension
- needs careful UX so field devices are not mis-targeted accidentally

## Suggested Decision Order

1. Add a visible environment indicator in the web app.
2. Stop using production DB as the default local target.
3. Decide whether we want:
   - just a dev DB, or
   - a full staging environment
4. Decide whether one bench ESP32 should be explicitly repointable between environments.

## Rule of Thumb

Use production data intentionally, not by default.

If local code is talking to production data, the app should make that unmistakably obvious.
