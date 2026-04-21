
Architectural truth in this repo must be derived from current code, tests, scripts, configs, and observed behavior, not from docs.

[docs/bugs/windows-ble-bugs.md](/home/adamblumoff/gym-motion/docs/bugs/windows-ble-bugs.md) is historical bug memory only. Use it for context, then verify everything against the current repo before acting on it.

Prefer repo-owned command surfaces like `bun run test`, `bun run lint`, `bun run typecheck`, and other package scripts over ad hoc command variants.

For bench USB flashing, prefer `bun run firmware:upload -- --port <serial-port>` so local flashes match the repo's OTA/CI partition settings.

After firmware changes, try a bench USB upload with `bun run firmware:upload -- --port <serial-port>` before handoff when hardware access is available and the local environment supports it.

The Linux BLE gateway lives at `/home/adamblumoff/gym-motion/native/linux-dotnet-ble-gateway`; treat it as product code.

Validate desktop changes from the current Windows repo checkout with `.env.local` present before running `bun install`, `bun run dev`, or `bun run build`.

Linux gateway development requires the local .NET SDK because the native gateway is built locally.
