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

## What To Check

In the app:

1. Open the `Setup` tab.
2. Confirm Bluetooth comes up automatically without any adapter picker.
3. Click `Scan nodes`, then power the BLE node and confirm it appears in the visible node list.
4. Click `Connect` on a visible node.
5. Confirm the gateway manages that node.
6. Click `Remove` and confirm the node stops being managed.
7. Confirm the restart control only exists in the header.

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
- Windows Bluetooth adapter selection is automatic and stays out of the UI.
- The `Setup` tab is node-only, and Bluetooth discovery is manual-only for discovery and pairing. Approved nodes should reconnect automatically in the background after app restarts or link loss.
- When an approved node loses power or the BLE link drops, the dashboard should move to `Disconnected` immediately instead of waiting for telemetry freshness to age out.
- While an approved node stays disconnected, the Windows app now keeps a silent approved-node reconnect scan running in the background. It should only show `Reconnecting` after that exact node is rediscovered and a real BLE reconnect attempt starts.
- After the gateway reconnects to a managed node, it sends a runtime `sync-now` control command so the node republishes its current telemetry without waiting for fresh motion.
- Managed firmware now tracks a Windows app-session lease for Windows runtime sessions. The sidecar first sends an `app-session-bootstrap` marker, then refreshes the lease every 5 seconds, and the node expires it after 15 seconds so it can drop a stale BLE session, restart advertising, and recover from app restarts that do not produce a clean OS-level disconnect. Provisioning-only sessions and legacy non-Windows runtime commands stay outside that lease watchdog.
- The firmware also keeps a short pre-bootstrap watchdog after BLE connect. If the Windows app dies before it can send `app-session-bootstrap`, the node should still drop that stale BLE client and resume advertising instead of staying stuck connected forever. Provisioning writes and legacy runtime control traffic should disarm that watchdog before it fires.
- Windows now counts real reconnect attempts per approved node. After 20 failed reconnect attempts for one paired node, auto-reconnect stops for that node and the homepage sensor card shows the forget-device prompt locally instead of using a global popup.
- Approved-node reconnect matching is now more permissive than manual discovery. During silent reconnect, the WinRT sidecar may accept a paired node by its saved peripheral id, BLE address, or local name even if Windows omits the runtime service UUID or local name from the reconnect advertisement. Manual discovery should remain stricter.
  That same silent-reconnect fallback must stay consistent across discovery, connect, and disconnect lifecycle events so a node recovered by saved identity is still tracked as connected and can stop the reconnect scan once the session is healthy.
- Reconnect scan bursts must not clear WinRT peripherals while a reconnect handshake is already in flight. On slower links, a healthy reconnect attempt should be allowed to finish service discovery, subscriptions, and the first lease write without the cache-reset loop invalidating the peripheral underneath it.
- A successful reconnect should clear the silent reconnect scan even if WinRT never emits a separate `DeviceConnected` event after the explicit connect call. Bench logs should settle out of the reconnect scan once the sidecar marks the session healthy.
- Reconnect attempt counters should only reset after the session proves healthy with real telemetry, not merely after GATT setup or the first lease write. Flaky links that drop before telemetry arrives should continue counting toward the 20-attempt exhaustion limit.
- The homepage `Forget Device` action should also clear older approval rules that only match by BLE address or local name, not just rules that already have a stable runtime id.
- Setup identity matching should treat BLE addresses case-insensitively, the same way the WinRT sidecar and runtime reconciliation already do.
- Firmware advertising must continue to expose the provisioning service UUID for first-time web provisioning, even after reconnect-advertising changes. The runtime reconnect identity can be more explicit, but the provisioning web flow still filters by `PROVISIONING_SERVICE_UUID`.
- Firmware now rebuilds its advertising payload on every reconnect restart so the `GymMotion-...` name stays in the primary advertisement and the runtime service stays in the scan response after lease expiry or forced disconnect. During bench testing, look for `[runtime] BLE client connected; runtime lease will arm after app-session lease traffic.`, `[runtime] Windows app session lease is active...`, `[runtime] Lease refreshed. ...`, `[runtime] Connected heartbeat. connected=1 leased=1 ...`, `[runtime] Lease expiry timeout fired. ...`, `[runtime] BLE runtime transport disconnected from the Windows app.`, `[runtime] Advertising for Windows app reconnect (...) as GymMotion-... with runtime scan response.`, and `[runtime] Still waiting for the Windows app; BLE advertising is active.` to distinguish a real app session from a stale or missing client.
- Approved rebooting nodes should stay under `Paired Sensors`; their badge there should match the dashboard state (`Reconnecting`, `Connected`, `Disconnected`) instead of falling back to a generic `Paired` label.
- Once a managed node reconnects and the gateway resolves its runtime `deviceId`, the desktop app now upgrades the saved approved-node rule to that stable identity so later reboots keep folding back into the same paired node instead of looking like a fresh setup candidate.
- Silent reconnect search should stay visually quiet: paired missing nodes remain `Disconnected` while the sidecar scans in the background, and only switch to `Reconnecting` after the sidecar rediscovers that node and starts a real reconnect attempt. The sidecar logs should still show the full reconnect/search sequence.
- Silent approved-node reconnect must never reuse the manual discovery state. On a normal link drop or app restart, the dashboard should stay in the quiet approved-node waiting/reconnect flow instead of showing `Scanning for BLE nodes` or disabling the Setup scan button as if the operator had started a manual scan.
- The legacy noble / raw-USB BLE path is now the non-Windows fallback, not the primary Windows implementation.
