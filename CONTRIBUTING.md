# Contributing to PhoneDock

## Requirements

- macOS 15 or later, with Xcode installed in `/Applications/Xcode.app`.
- Node.js 24 or later. PhoneDock runs its TypeScript sources directly with Node's built-in type stripping; there
  is no compile step.
- For the backends you work on: the Android SDK command-line tools and emulator, AXe (iOS simulator input), and
  `pymobiledevice3` (real iPhones). `./bin/phonedock backends` reports what's missing.

## Build from source

```sh
npm install

# Service (daemon) and CLI: no build needed. Any command starts the service if it isn't running.
./bin/phonedock daemon start
./bin/phonedock backends
./bin/phonedock --help

# Mac app (debug build). If xcode-select points at the Command Line Tools, DEVELOPER_DIR is required.
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build --package-path app
app/.build/debug/PhoneDock

# Packaged app, zip and DMG in dist/ (bundles Node, the service and the CLI). Ad-hoc signed: runs on this Mac.
bash scripts/build-app.sh
```

A debug build of the app runs the service from this checkout with the `node` on your `PATH`. The packaged app
runs its bundled copy; its CLI is at `PhoneDock.app/Contents/Resources/bin/phonedock`. The bundled Node is the
`node` on your `PATH` (or `NODE=/path/to/node`), so use an official Node.js build.

## Releasing

A release DMG must be signed with a Developer ID and notarized, or Gatekeeper blocks it on other Macs.

```sh
# Once: store App Store Connect credentials for notarytool in your keychain.
xcrun notarytool store-credentials phonedock-notary --apple-id <apple-id> --team-id <team-id>

# Build, sign (hardened runtime), notarize and staple. Writes dist/PhoneDock-<version>.{dmg,zip} and SHA256SUMS.txt.
PHONEDOCK_NOTARY_PROFILE=phonedock-notary bash scripts/build-app.sh --release
```

The first `Developer ID Application` identity in your keychain is used; set `PHONEDOCK_SIGN_IDENTITY` to pick
another. Bump `version` in `package.json` first, then attach the DMG, the zip and `SHA256SUMS.txt` to a GitHub
release tagged `v<version>`. The README links to the latest release.

## Tests

```sh
npm test                  # unit tests (node --test)
npx tsc --noEmit -p .     # type check
```

TypeScript rules (Node's type stripping only supports erasable syntax):
- No `enum`, `namespace` or constructor parameter properties.
- Relative imports include the `.ts` extension.
- Run external tools through `src/core/exec.ts` with argv arrays, never shell strings.

`scripts/e2e-android.sh` drives the Android backend end to end on a test emulator through the service, the CLI and
MCP. `scripts/build-android-helper.sh --check` confirms the embedded on-device Android helper matches its Java source
(`--update` after you change it).

`scripts/e2e-agent.sh "<task>"` runs a headless Claude Code agent that can use only the PhoneDock MCP tools. It's
useful for checking that a change works for agents end to end.

## Repo layout

| Path | What's there |
|---|---|
| `src/core` | The contract (`types.ts`: `Backend`, `Device`, coordinates) and shared helpers (`exec.ts`, `paths.ts`) |
| `src/daemon` | The local HTTP + SSE service ([docs/API.md](docs/API.md)) |
| `src/backends` | One file per device provider. Adding a backend means implementing `Backend` and registering it in `index.ts` |
| `src/mcp`, `src/cli`, `src/sdk` | Agent interfaces: MCP server, CLI, TypeScript SDK |
| `sdk/python` | Python SDK (standard library only) |
| `app/` | The SwiftUI Mac app. Design tokens and shared components are in `Theme.swift`; see [design/DESIGN.md](design/DESIGN.md) |
| `tools/` | Native helpers: Vision OCR, iPhone sidecars |
| `fixtures/ios-sample` | A small iOS app for simulator tests |
| `scripts/` | App packaging, bundling, agent end-to-end runs |
| `docs/` | [Agent guide](docs/AGENTS-GUIDE.md), [architecture](docs/ARCHITECTURE.md), [iPhone setup](docs/IPHONE-WIFI.md), [research](docs/RESEARCH.md) |

## Device safety

PhoneDock can drive every simulator, emulator and phone on your Mac. When testing:

- Name every device you create with the prefix **`pdtest-`** and delete it when you're done.
- Don't boot, shut down, erase or send input to devices you didn't create, including your own simulators, AVDs
  and phones.
- Always pass `-s <serial>` to `adb`, and never `adb connect` to a network address you don't own. Other devices on
  your network (TVs, for example) accept adb input.
- Run a separate test service on its own port so you don't disturb the one the app uses (47420):

  ```sh
  PHONEDOCK_PORT=47450 ./bin/phonedock daemon start
  PHONEDOCK_PORT=47450 ./bin/phonedock create --backend android-emulator --name pdtest-pixel --profile pixel_9 --boot
  # … pass the same PHONEDOCK_PORT to every CLI, SDK and MCP call …
  PHONEDOCK_PORT=47450 ./bin/phonedock rm pdtest-pixel
  PHONEDOCK_PORT=47450 ./bin/phonedock daemon stop
  ```

  It shares the data folder but writes `daemon-<port>.json`, so the two never collide. Leases are per service,
  so they don't protect your test devices from other services.
- Add `PHONEDOCK_DEVICE_FILTER=pdtest-` to that test service and it only sees and controls devices named
  `pdtest-…`, refuses other names, and can't connect to physical phones. Use it whenever an agent drives the tests.

## App self-test

Debug builds can drive their own UI from a JSON script, for screenshots and UI checks without touching any device.
It's off unless `PHONEDOCK_APP_SELFTEST` is set.

```sh
cat > /tmp/pd-selftest.json <<'JSON'
{"steps":[
  {"op":"appearance","mode":"dark"},
  {"op":"select","device":"pdtest-pixel"},
  {"op":"wait","ms":3000},
  {"op":"screenshot","path":"/tmp/pd-main.png"}
]}
JSON
PHONEDOCK_PORT=47450 PHONEDOCK_APP_SELFTEST=/tmp/pd-selftest.json PHONEDOCK_APP_SELFTEST_QUIT=1 \
  app/.build/debug/PhoneDock &
tail -f /tmp/pd-selftest.json.log      # ends with "DONE" or "DONE with N failure(s)"
```

Each step is logged to `<script>.log` (override with `PHONEDOCK_APP_SELFTEST_LOG`), and
`PHONEDOCK_APP_SELFTEST_QUIT=1` quits the app when the script ends. Common ops:

| Op | Arguments |
|---|---|
| `wait` | `ms` |
| `appearance` | `mode`: `light`, `dark` or `system` |
| `select` | `device`: a sidebar device's name or id (selects it; sends no input) |
| `sheet` | `name`: `connect`, `create` or `agent` |
| `screenshot` | `path`, optional `sheet: true` |
| `toast` | `title`, `message`, `details` |
| `fakeScreenError` | `message`, `hints` (shows a screen error without touching a device) |
| `button` | `title` (clicks it, in an attached sheet first) |
| `waitFor` / `waitGone` | `text`, `timeoutMs` |
| `focus`, `type`, `key` | `label`; `text` (add `field: true` to refuse unless a text field has focus); `keyCode` |
| `click` | `wx`, `wy` in window points, top-left origin (refused on the device screen unless `screen: true`) |
| `mark`, `dumpAX` | `text` (logs `MARK <text>`); logs the accessibility tree |

The full list is at the top of `app/Sources/PhoneDock/SelfTest.swift`. `tap` and `drag` send real input to the
selected device, and so can `type` and `key` without `field: true` when the screen has focus. Use them only on
`pdtest-` devices.

## Pull requests

- Keep the contract in `src/core/types.ts` and `docs/API.md` backward compatible: add fields, don't rename or
  remove them.
- Follow [design/DESIGN.md](design/DESIGN.md) for anything visible in the app.
- Run `npm test` and `npx tsc --noEmit -p .` before you open a PR, and say how you tested on a device.
