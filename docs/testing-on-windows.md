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

## Dev Run

From **PowerShell**:

```powershell
cd C:\Users\adamb\Code\gym-motion
bun run dev
```

Use this path for the first real validation because the BLE adapter and `@abandonware/noble` behavior need to be exercised from Windows itself.

## What To Check

In the app:

1. Open the `Setup` tab.
2. Confirm the adapter list appears.
3. Select the adapter the gateway should use.
4. Confirm the gateway restarts after adapter selection.
5. Power the BLE node and confirm it appears in the visible node list.
6. Approve one or more nodes.
7. Confirm the gateway restarts and only approved nodes reconnect.
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
- BLE adapter selection and node approval both live in the `Setup` tab.
- Adapter changes and node approval changes restart the gateway runtime.
