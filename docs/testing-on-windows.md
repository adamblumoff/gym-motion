# Testing On Windows

read_when: you need to run the Electron app against real Windows BLE adapters or validate the packaged Windows build.

## Working Copy

The preferred Windows-native test copy lives at:

- `C:\Users\adamb\Code\gym-motion`

Recommended workflow:

1. Commit and push the current repo state from WSL.
2. On Windows, clone the repo into `C:\Users\adamb\Code\gym-motion`.
3. Copy `.env.local` into that Windows repo, because it is not tracked.

This Windows copy must include `.env.local` to run the real desktop runtime.

## First-Time Setup

Open **PowerShell** and run:

```powershell
cd C:\Users\adamb\Code\gym-motion
bun install
```

Make sure Bun is installed on Windows before running the desktop app.

Then install the Rust MSVC toolchain on Windows, because the app now builds a native BLE sidecar for built-in Windows Bluetooth support:

```powershell
winget install Rustlang.Rustup
rustup default stable-aarch64-pc-windows-msvc
```

## Dev Run

From **PowerShell**:

```powershell
cd C:\Users\adamb\Code\gym-motion
bun run dev
```

Use this path for the first real validation because the Windows-native BLE sidecar and built-in Bluetooth behavior need to be exercised from Windows itself.

Treat this as the primary product validation path. The current desktop runtime should be considered Windows-only for operator use.

If you need the full WinRT reconnect trace while debugging, set:

```powershell
$env:GATEWAY_VERBOSE="1"
bun run dev
```

Normal mode now suppresses the step-by-step reconnect handshake chatter and repeated unchanged adapter snapshots. `GATEWAY_VERBOSE=1` turns those detailed sidecar logs back on.

## What To Check

In the app:

1. Open the `Setup` tab.
2. Confirm Bluetooth comes up automatically without any adapter picker.
3. Click `Scan nodes`, then power the BLE node and confirm it appears in the visible node list.
4. Click `Pair` on a visible node.
5. Confirm the gateway manages that node.
6. If a paired node stays disconnected, use `Recover` and confirm the row shows the latest failure reason if recovery still fails.
7. Click `Remove` and confirm the node stops being managed.
8. Confirm the restart control only exists in the header.

## Packaged Build

From **PowerShell**:

```powershell
cd C:\Users\adamb\Code\gym-motion
bun run build:win
```

After the build completes, launch the newest `.exe` from `release\`.

Validate the same Setup and reconnect flow in the packaged app.

## Notes

- `.env.local` is required for meaningful desktop testing because the app reads database and storage config at startup.
- The desktop runtime is real, not mock-backed.
- Windows now uses the Rust WinRT BLE sidecar and should work with built-in Windows Bluetooth adapters.
- The current desktop product is Windows-only. Bench validation should target the Windows app, the WinRT sidecar, and the ESP32 firmware runtime protocol together.
- Approved-node identity matching on the desktop should come from one shared `desktop/core` policy. Setup visibility, pairing badges, paired-row folding, and approved-node reconciliation should all follow the same precedence: `knownDeviceId`, then `peripheralId`, then BLE address, then unique `localName`.
- Windows Bluetooth adapter selection is automatic and stays out of the UI.
- The `Setup` tab is node-only, and Bluetooth discovery is manual-only for discovery and pairing. Approved nodes should reconnect automatically in the background after app restarts or link loss.
- When an approved node loses power or the BLE link drops, the dashboard should move to `Disconnected` immediately instead of waiting for telemetry freshness to age out.
- While an approved node stays disconnected, the Windows app now keeps a silent approved-node reconnect scan running in the background. It should only show `Reconnecting` after that exact node is rediscovered and a real BLE reconnect attempt starts.
- After the gateway reconnects to a managed node, it sends a runtime `sync-now` control command so the node republishes its current telemetry without waiting for fresh motion.
- Managed firmware now tracks an app-session lease for runtime BLE sessions. The Windows sidecar sends an `app-session-bootstrap` marker, then refreshes the lease every 5 seconds, and the node expires it after 15 seconds so it can drop a stale BLE session, restart advertising, and recover from app restarts that do not produce a clean OS-level disconnect. Provisioning-only sessions stay outside that lease watchdog.
- The firmware now starts a short pre-bootstrap watchdog as soon as a BLE client connects so a Windows app crash before telemetry subscription cannot strand the node on a stale GATT link. Real provisioning activity should immediately cancel that watchdog so provisioning-only sessions stay connected and never get treated like runtime sessions just because they share the same BLE server.
- Windows now counts real reconnect attempts per approved node. After 20 failed reconnect attempts for one paired node, auto-reconnect stops for that node and the homepage sensor card shows the forget-device prompt locally instead of using a global popup.
- Approved-node reconnect matching is now more permissive than manual discovery. During silent reconnect, the WinRT sidecar may accept a paired node by its saved peripheral id, BLE address, or local name even if Windows omits the runtime service UUID or local name from the reconnect advertisement. Manual discovery should remain stricter.
  That same silent-reconnect fallback must stay consistent across discovery, connect, and disconnect lifecycle events so a node recovered by saved identity is still tracked as connected and can stop the reconnect scan once the session is healthy.
  If a manual Setup scan overlaps that silent reconnect window, the reconnect fallback should still stay active for missing approved nodes; the manual scan label must not pause approved-node recovery.
  After the retry-exhausted cutoff, a manual Setup scan should still be able to rediscover that paired node by its saved identity so the operator can recover it without first forgetting the device.
  A targeted `Recover` action for one paired node is allowed to reset that node's exhausted background retry state and should log the exact reconnect stage if it fails again.
- Reconnect scan bursts must not clear WinRT peripherals while a reconnect handshake is already in flight. On slower links, a healthy reconnect attempt should be allowed to finish service discovery, subscriptions, and the first lease write without the cache-reset loop invalidating the peripheral underneath it.
  Those scan bursts should also pause entirely while a reconnect handshake is in flight, so the first reconnect attempt gets a stable shot without the scan restart loop churning underneath it.
- Regression guardrail: WinRT reconnect handshakes must pause active scanning before GATT setup starts. We hit a real regression where the ESP32 logged `BLE client connected` and started sending `ready`/telemetry, but the sidecar still saw `connect()` and then `discover_services()` fail with `Not connected` because scan/connect contention left the GATT session unstable. In that state the sidecar never reached `app-session-bootstrap` or `app-session-lease`, and the firmware correctly dropped the stale Windows session.
- Separate guardrail: even after scan pause is correct, WinRT can still surface a rediscovered device before its first uncached GATT fetch is stable. On this stack, the durable fix is in the WinRT transport layer: use `GattSession.MaintainConnection` to wait for a real connected state before uncached GATT discovery, rather than papering over `connect() -> Not connected` with extra sidecar settle delays or repeated peripheral refreshes.
- If a reconnect handshake fails after the BLE link comes up but before the session is healthy, the sidecar must explicitly disconnect that stale client immediately instead of waiting for the node-side bootstrap timeout to clean it up.
- A successful reconnect should clear the silent reconnect scan even if WinRT never emits a separate `DeviceConnected` event after the explicit connect call. Bench logs should settle out of the reconnect scan once the sidecar marks the session healthy.
- Reconnect attempt counters should only reset after the session proves healthy with real telemetry, not merely after GATT setup or the first lease write. Flaky links that drop before telemetry arrives should continue counting toward the 20-attempt exhaustion limit.
  Bench logs should stop at attempt `20`; duplicate rediscovery while attempt `20` is already in flight must not produce fake `21` retries.
- Raw WinRT `DeviceConnected` events are not enough to declare the session healthy on their own. The sidecar should wait for the first telemetry packet before stopping silent reconnect scanning or resetting the reconnect-attempt counter.
- Approved reconnect should emit one `connecting` transition per real attempt. A duplicate `connecting` event from the sidecar can knock a device back out of the UI's `reconnecting` state during the same retry, so bench logs and snapshots should show a single reconnect transition until telemetry proves the session healthy.
- If an exhausted paired node is forgotten and then re-paired without restarting the app, the sidecar must drop the old exhausted retry state when the approved-node list changes so the new pairing can auto-reconnect immediately.
- Forgetting a currently connected Windows sensor should disconnect that BLE peripheral immediately, not just remove it from the saved allow-list and wait for the link to die later.
- The homepage `Forget Device` action should also clear older approval rules that only match by BLE address or local name, not just rules that already have a stable runtime id.
- Local-name fallback for that forget action must stay ambiguity-safe. If multiple approved nodes share the same advertised name, forgetting one must not silently remove the others.
- Setup identity matching should treat BLE addresses case-insensitively, the same way the WinRT sidecar and runtime reconciliation already do.
- Setup node folding should continue to honor older name-only approvals too. If a paired node was originally saved only by `localName`, rediscovery should still collapse back into that approved entry instead of showing both the placeholder and a fresh discovery row.
- That local-name fallback must stay ambiguity-safe in both runtime reconciliation and Setup folding. If multiple saved approvals share the same name-only identity, a single advertising device must not cause them all to collapse onto one runtime/discovery row or be silently deduped out of preferences.
- The same ambiguity rule applies to silent reconnect and Setup approval badges: a shared `localName` is not strong enough to prove a physical sensor’s identity on its own. Auto-reconnect and “already approved” state should only use `localName` when that name-only identity is unique.
- Setup discovery should follow that same rule when deciding whether a visible node is already paired. Pairing one duplicate-name node must not hide its siblings from the visible list as “already paired.”
- Firmware advertising must continue to expose the provisioning service UUID for first-time web provisioning, even after reconnect-advertising changes. The runtime reconnect identity can be more explicit, but the provisioning web flow still filters by `PROVISIONING_SERVICE_UUID`.
- Firmware now rebuilds its advertising payload on every reconnect restart so the `GymMotion-...` name stays in the primary advertisement and the runtime service stays in the scan response after lease expiry or forced disconnect. During bench testing, look for `[runtime] BLE client connected; runtime lease will arm after app-session lease traffic.`, `[runtime] Windows app session lease is active...`, `[runtime] Lease refreshed. ...`, `[runtime] Connected heartbeat. connected=1 leased=1 ...`, `[runtime] Lease expiry timeout fired. ...`, `[runtime] BLE runtime transport disconnected from the Windows app.`, `[runtime] Advertising for Windows app reconnect (...) as GymMotion-... with runtime scan response.`, and `[runtime] Still waiting for the Windows app; BLE advertising is active.` to distinguish a real app session from a stale or missing client.
- When reconnect is flaky, treat failures as a protocol problem across all three layers: Windows app, WinRT sidecar, and firmware. The useful failure stages are discovery match, transport connect, service discovery, telemetry subscribe, `app-session-bootstrap`, `sync-now`, `app-session-lease`, and first telemetry.
  One especially important signature is: firmware logs `BLE client connected` plus `ready` telemetry, while the sidecar logs `connect()`/`discover_services()` -> `Not connected`. That pattern means the OS-level link briefly came up but GATT setup was not stable enough to begin the runtime lease handshake.
- Approved rebooting nodes should stay under `Paired Sensors`; their badge there should match the dashboard state (`Reconnecting`, `Connected`, `Disconnected`) instead of falling back to a generic `Paired` label.
- Once a managed node reconnects and the gateway resolves its runtime `deviceId`, the desktop app now upgrades the saved approved-node rule to that stable identity so later reboots keep folding back into the same paired node instead of looking like a fresh setup candidate.
- Those reconciled approved-node rules should be pushed into the running Windows gateway immediately, not just saved in preferences, so the active WinRT reconnect path starts using the upgraded identities without a manual restart.
- Silent reconnect search should stay visually quiet: paired missing nodes remain `Disconnected` while the sidecar scans in the background, and only switch to `Reconnecting` after the sidecar rediscovers that node and starts a real reconnect attempt. The sidecar logs should still show the full reconnect/search sequence.
- That background approved-reconnect search should stay quiet in device activity too. Repeated rediscovery while the sidecar is silently retrying must not spam duplicate `node.discovered` device-log rows; discovery logging should stay reserved for operator-visible/manual scans, including the first discovery right after scan mode changes.
- Silent approved-node reconnect must never reuse the manual discovery state. On a normal link drop or app restart, the dashboard should stay in the quiet approved-node waiting/reconnect flow instead of showing `Scanning for BLE nodes` or disabling the Setup scan button as if the operator had started a manual scan.
- Programmatic silent reconnect requests must also stay on that background path. They should refresh approved-node reconnect policy without triggering the manual scan window or flipping `scanReason` to `manual`.
- Legacy/non-Windows runtimes may still omit `scanReason` in old development paths. In the supported Windows app, `scanReason` should remain explicit so reconnect-specific status is not confused with operator-visible scanning.
- Address-only reconnect recovery should normalize BLE address casing before looking up known nodes, so the same WinRT device still resolves to its existing `deviceId` even if the adapter reports `AA:BB...` vs `aa:bb...` across sessions.
- That BLE address also needs to survive both runtime `/devices` merges and later repository refreshes. After a node is known by address, live ingest/heartbeat updates should not erase the address from dashboard/setup state or the address-based pairing/recovery flows will silently stop working.
- `scanReason` is required on the supported Windows path. Manual discovery should report `manual`, background approved-node recovery should report `approved-reconnect`, and the UI should never guess between them on Windows.
- Paired sensor rows should keep showing the saved BLE address when one is known, even if the live runtime device also has an opaque WinRT peripheral handle.
- Those paired rows should also bind to live runtime devices by strongest available identity first (`knownDeviceId`, then peripheral/address, then only safe fallbacks). A shared local name must not let one live sensor borrow another paired row's address, signal, or connection badge.
- That same duplicate-name guard applies to reconnect bookkeeping too: one connected/recovered node must never satisfy multiple saved name-only approvals just because they share a `localName`.
- The older noble / raw-USB BLE path is not part of the supported Windows product flow and should not be used to justify changes in the active WinRT architecture.
