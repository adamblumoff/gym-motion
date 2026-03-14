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
- The `Setup` tab is node-only, and Bluetooth discovery is manual-only. Scan when you want to find or reconnect nodes.
- The legacy noble / raw-USB BLE path is now the non-Windows fallback, not the primary Windows implementation.
