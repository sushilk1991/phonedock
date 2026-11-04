# PhoneDock: notes for coding agents working on this repo

- Runtime: Node 24 or later runs `.ts` directly (type stripping), as `package.json` `engines` says.
  Only erasable TypeScript: no `enum`, no `namespace`, no constructor parameter properties.
  Relative imports must include the `.ts` extension.
  Check with `npx tsc --noEmit -p .` and `npm test`. Build the Mac app with `cd app && swift build`. If
  `xcode-select` points at the Command Line Tools, set `DEVELOPER_DIR` to your Xcode (`toolEnv()` does this for tools).
- Contract: `src/core/types.ts` (the Backend interface, Device, and coordinates in screenshot pixels) and `docs/API.md`.
  Add fields rather than renaming or removing them, and call out any contract change in your PR.
- Shared helpers: `src/core/exec.ts` (run/runBuffer/waitFor, with argv arrays only and never shell strings) and
  `src/core/paths.ts` (SDK/Xcode/Java discovery, `toolEnv()`, `stateDir()`).

## Testing without touching other devices
- Name every test device you create with the prefix `pdtest-` and delete it when you're done.
- Run your own daemon on a spare port with a filter, so it only sees your test devices:
  `PHONEDOCK_PORT=<port> PHONEDOCK_DEVICE_FILTER=pdtest- ./bin/phonedock daemon start`. Pass the same `PHONEDOCK_PORT`
  to every CLI, SDK and MCP call. Leave the default daemon on 47420 alone, because the Mac app uses it.
- Always pass `-s <serial>` to adb, and never `adb connect` to network addresses.
