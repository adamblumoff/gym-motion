# Previous Bugs

This file captures BLE/runtime bugs we already paid to learn the hard way.

Use it before changing the Windows BLE reconnect flow, the ESP32 app-session
protocol, or the vendored WinRT `btleplug` package.

## Scope

- Desktop product target: Windows app + Rust WinRT sidecar + ESP32 firmware
- Main BLE transport code:
  - `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/mod.rs`
  - `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/src/windows/handshake.rs`
  - `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/vendor/btleplug-winrt-patched`
- Firmware app-session code:
  - `/home/adamblumoff/gym-motion/firmware/runtime_ble.ino`

## Rules Of Thumb

- The sidecar owns BLE transport truth.
- The firmware owns app-session lease truth.
- Electron/runtime server should project BLE state, not invent it.
- Do not reuse WinRT GATT handles across reconnect churn unless they were
  refreshed from a fresh discovery pass.
- Do not fall back to reconnect scan bursts until in-session recovery has
  failed.
- Treat `is_connected()` as weaker than “current characteristic handles are
  valid.” A peripheral can look connected while specific WinRT objects are dead.

## Bug 1: Silent Scan Incorrectly Showed "Reconnecting"

### Symptom

- Powering a node off showed `Reconnecting` in the UI instead of `Disconnected`.

### Root Cause

- The backend promoted disconnected approved nodes to `reconnecting` just
  because silent approved-node scan was active.
- Global scan state was being confused with per-node connection state.

### Fix

- Only mark a node `reconnecting` when a real connect attempt starts.
- Keep silent approved-node scan as gateway-level state only.

### Watch Out For

- Any future code that derives node transport state from scan state alone is
  probably wrong.

## Bug 2: Approved Reconnect Started From Weak Discovery Data

### Symptom

- Reconnect attempts started too early and often failed on the first try.

### Root Cause

- Windows advertisements can arrive in partial pieces.
- Reconnect was sometimes starting from name/address fallback before the runtime
  service UUID had been observed.

### Fix

- Wait for the runtime service before starting reconnect.
- Use the discovery registry as the source of truth, not single advertisement
  callbacks.

### Watch Out For

- Don’t weaken reconnect candidate rules just to make reconnect start sooner.

## Bug 3: Stale Session Ack Falsely Marked Reconnect Healthy

### Symptom

- Sidecar logged `Reconnect completed`, but firmware still showed no active
  lease/session.

### Root Cause

- Session identity was too weak across reconnect attempts.
- Old app-session status could satisfy a new reconnect attempt.

### Fix

- Generate a fresh `sessionId` per connect attempt.
- Add a fresh `sessionNonce` in `app-session-bootstrap`.
- Require matching `sessionId` and `sessionNonce` in `app-session-online`.
- Require live telemetry after the ack before marking reconnect complete.

### Watch Out For

- `app-session-online` alone is not enough proof of a healthy reconnect.

## Bug 4: Cold Boot Was Different From Normal Reconnect

### Symptom

- Power-cycling the ESP32 often needed an extra attempt even when normal
  reconnects worked.

### Root Cause

- Fresh boot has a real readiness window.
- We were treating “freshly booted node” and “already-running node” as the same
  case.

### Fix

- Firmware now exposes a `ready` payload with `bootId` and `bootUptimeMs`.
- Sidecar reads that status and waits briefly before starting app-session
  bootstrap when the node just booted.

### Watch Out For

- If first-attempt reconnects regress mainly after power-cycles, inspect boot
  readiness first.

## Bug 5: WinRT Characteristic Handles Became Invalid After Reconnect

### Symptom

- Errors like:
  - `HRESULT(0x80000013)`
  - `The object has been closed.`
- Appeared on subscribe, bootstrap, lease writes, or steady-state lease
  heartbeat.

### Root Cause

- WinRT GATT objects can become stale across disconnect/reconnect churn even if
  the service UUIDs are unchanged.
- Cached service/characteristic handles in the vendored `btleplug` layer were
  reused too aggressively.

### Fix

- Use uncached service discovery in the vendored WinRT device layer.
- Rebuild service/characteristic caches on every discovery pass.
- Preserve full WinRT error chains so the real HRESULT surfaces in logs.

### Watch Out For

- A healthy-looking connection does not guarantee the control/status handles are
  still live.

## Bug 6: Lease Heartbeat Dropped To Full Reconnect Scan Too Early

### Symptom

- Session came up successfully.
- Then a steady-state lease heartbeat hit `The object has been closed.`
- Sidecar fell back to reconnect scan bursts, causing slow recovery.

### Root Cause

- Closed-handle lease failures were treated like “session is gone,” not “control
  path needs repair.”

### Fix

- Add in-session recovery before scanning:
  - refresh services
  - reacquire control characteristic
  - replay bootstrap + lease
  - restart heartbeat
- Only fall back to reconnect scan bursts if in-session recovery fails.

### Watch Out For

- If reconnect is fast but post-connect lease still drops, the bug is probably
  in the steady-state control path, not discovery.

## Bug 7: Transient Disconnect During Handshake Invalidated Current Handles

### Symptom

- Logs showed `Ignoring transient disconnect ... after transport re-check`
- Then later in the same handshake, bootstrap or lease writes failed with
  `The object has been closed.`

### Root Cause

- Even if transport comes back, handles acquired before the bounce may already
  be invalid.

### Fix

- Treat closed-handle bootstrap/lease failures as retryable pre-session setup
  failures.
- Refresh services and rerun setup on the same connection before giving up.

### Watch Out For

- During handshake, a transient disconnect should be treated as a possible
  handle invalidation event, not just a logging curiosity.

## Bug 8: Logging Hid The Real WinRT Failure

### Symptom

- Logs only showed top-level messages like:
  - `status subscribe step failed`
  - `chunked control write failed after 3 attempts`

### Root Cause

- `anyhow` error chains were being collapsed to `error.to_string()`, which
  dropped the inner WinRT/HRESULT details.

### Fix

- Preserve full error chains in reconnect/setup/lease logging.
- In the vendored layer, use result-returning WinRT APIs so the underlying
  `GattCommunicationStatus` and protocol details can surface.

### Watch Out For

- If logs suddenly get generic again, check whether a new wrapper started
  truncating error chains.

## Bug 9: Full Rediscovery Scan Is Expensive

### Symptom

- After a control-path problem, recovery required many reconnect scan bursts
  before another attempt started.

### Root Cause

- We were using “scan again” as an early recovery path instead of last resort.

### Fix

- Prefer this recovery order:
  1. in-session control-path recovery
  2. same-connection setup refresh
  3. reconnect attempt to known node
  4. reconnect scan bursts only as fallback

### Watch Out For

- If future changes increase scan-burst counts again, check whether an earlier
  recovery stage was removed or bypassed.

## Firmware Protocol Notes

- `app-session-bootstrap` carries `sessionNonce`
- `app-session-lease` carries `sessionId`
- Firmware should only mark session online after both are coherent
- Firmware emits `app-session-online` with both:
  - `sessionId`
  - `sessionNonce`
- Firmware also exposes a `ready` payload with:
  - `bootId`
  - `bootUptimeMs`

If any future agent changes these fields, they must audit the sidecar handshake
and session-health validation together.

## Low-Level Package Notes

The vendored package is product code for now:

- `/home/adamblumoff/gym-motion/native/windows-ble-sidecar/vendor/btleplug-winrt-patched`

Important lessons:

- Uncached service discovery is safer than cached discovery for reconnect churn.
- Rebuilding characteristic handles is safer than trusting UUID equality.
- Closed WinRT object errors should trigger handle refresh/recovery, not just
  retries against the same stale object.

## Future Debugging Checklist

When BLE reconnect regresses, check these in order:

1. Did reconnect start from a strong candidate with `runtimeServiceMatched`?
2. Did `app-session-online` include the expected `sessionId` and `sessionNonce`?
3. Did live telemetry arrive before declaring reconnect complete?
4. Is the node freshly booted and still inside the boot-readiness window?
5. Did any WinRT call fail with `The object has been closed.`?
6. Did the sidecar attempt in-session recovery before falling back to scan?
7. Are logs still preserving full inner error chains?

If a future agent sees scan bursts after a previously healthy session, assume a
control-handle recovery regression before assuming discovery is broken.
