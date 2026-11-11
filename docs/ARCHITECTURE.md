# PhoneDock architecture

```
 ┌──────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐
 │ PhoneDock.app│  │ phonedock  │  │ MCP server │  │ SDK (TS/Py)  │   ← humans / agents
 │  (SwiftUI)   │  │   (CLI)    │  │ stdio/HTTP │  │              │
 └──────┬───────┘  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘
        └────────────────┴───── HTTP + SSE (127.0.0.1, bearer token) ┘
                               ┌───────────────────────┐
                               │ phonedockd (Node)     │ leases · jobs · action log · replay
                               │ device registry/state │ pools · streaming fan-out · OCR fallback
                               └──────────┬────────────┘
                                          │ Backend interface (src/core/types.ts)
   ┌──────────────┬──────────────┬────────┴──────┬──────────────┬──────────────┐
 android-emulator android-device  ios-simulator   ios-device       qemu*          corellium*
 (QEMU/HVF,       (adb USB/Wi-Fi, (CoreSimulator, (devicectl; iOS  (any OS image: (cloud, real iOS
  real Android     scrcpy)         simctl + AXe)   27+ CoreDevice   Linux,         & Android VMs)
  system images)                                   services; older  postmarketOS)
                                                   iOS: WDA)
                                                                    * experimental
```

## Design rules
- **One contract.** Every backend implements `Backend` in `src/core/types.ts`. Clients never talk to a
  backend directly, so adding an OS / hypervisor / cloud provider is one new file in `src/backends/` plus a
  line in `src/backends/index.ts`. Optional methods = optional capabilities; the daemon answers
  `501 not_supported` with hints instead of hiding the feature.
- **One coordinate space.** All x/y and element bounds are full-resolution screenshot pixels. Backends
  convert to native units (iOS points, QEMU absolute axes). The MCP layer rescales for downsized screenshots.
- **Devices outlive processes.** Emulators/VMs are spawned detached; the daemon can restart without killing
  phones. `autoStart` devices boot when the daemon starts; `phonedock daemon install-agent` installs a
  LaunchAgent so that happens at login.
- **Multi-agent safety.** Leases (`/lease`, `/pool/acquire`) give an agent exclusive input; `app:human`
  can force a takeover from the dashboard at any time. Per-device queues keep the primitives of a fill/batch
  together; guards check current ownership before mutations. `device-claims.ts` adds atomic SQLite claims shared
  by upgraded daemons using the same `PHONEDOCK_HOME`. Unleased input holds a temporary claim while executing.
  Different homes, older daemons and unrelated tools are outside this coordination. Every action is appended to a per-device JSONL log
  (visible in the app's Activity tab and replayable).
- **Accessibility first, vision second.** `/ui` returns the accessibility tree (uiautomator, AXe, the iOS 27
  remote accessibility service, or WebDriverAgent) with short refs (`e12`) the agent can tap; when it's empty,
  macOS Vision OCR produces text elements with tap-ready centers. Screenshots are always available for visual
  reasoning.
- **Reuse, don't rebuild.** Android Emulator (QEMU + HVF), adb, scrcpy, ffmpeg, CoreSimulator/simctl,
  AXe (simulator HID + accessibility), devicectl and Apple's CoreDevice services, pymobiledevice3, WebDriverAgent,
  upstream QEMU, the MCP SDK.

## Discovery and request execution

`inventory.ts` caches each provider independently and bounds the caller's wait. A slow provider does not hold the
aggregate list; previous results are served with stale/refresh/error metadata. A timeout leaves the underlying
call single-flight until it settles. Full device IDs target one provider, and `/v1/inventory` exposes providers
whose first result is still pending. TS/Python name, native-ID and prefix resolution waits up to five seconds
for all initial providers before deciding uniqueness/absence, returning `inventory_pending` while warming or
`inventory_incomplete` after a failed/timed-out first discovery. Canonical `backend:nativeId` bypasses that
aggregate resolution and targets the provider directly.

`execution.ts` owns per-device queues, request-local delivery accounting, and ownership fences. `delivery.ts`
keeps optional post-input UI enrichment within the queued claim lifetime. `requests.ts` records a write-ahead
receipt before ID-bearing input: an interrupted receipt means delivery unknown, never an instruction to replay.
Receipts are scoped by device and owner and redact caller-marked secret text. Completed/dead records expire after
24 hours; live running receipts survive longer, including when completion persistence failed. The 1,024-file
bound applies backpressure (`503 request_store_full`) instead of discarding a live receipt and allowing replay. The SDKs expose GET receipt recovery; a response lost after sending input is never automatically replayed.

UI snapshots have their own IDs (up to two minutes / 512 entries), action generations, and optional native
completion/app provenance. A ref plus `snapshotId` selects its original observation even if another client has
read the screen; current-screen verification still precedes input. `/find` returns `snapshotId`, and successful
visible `/wait` returns `snapshotId` plus its screen. MCP records the latest `get_ui` or visible `wait_for` snapshot
per session. `returnUi` can attach post-input observation in one response without requiring it on every action.

`/v1/metrics` separates route, backend, and `input.queue` / `input.execute` phase timing. Percentiles use the last
1,024 samples per key; lifetime counts/maxima describe the daemon process, not device frame performance.

## Test environment and evidence

`environment.ts` exposes simulator/emulator permission, biometric, status-bar, and media-library controls through
one validated action contract. Clipboard PUT/POST is also queued input, with delivery/retry safety and optional
request receipts; GET remains a read. Physical-device pre-grants and virtual-camera injection are excluded. iOS
biometric notification recipes are experimental. `ui-audit.ts` reports heuristic findings from one tree, while
`doctor.ts` checks host prerequisites without contacting devices. Android WebView diagnostics are a separate,
read-only debug-enabled DOM/network view; diagnostic refs are not native refs, and CSS bounds are not device pixels.
There is no iOS DOM bridge or interception of native app HTTP.

CLI and MCP flows share `image-comparison.ts`: FFmpeg decodes full-resolution RGBA, explicit thresholds and ignore
rectangles determine the changed-pixel fraction, and missing decoding never silently passes a baseline. Baseline
paths are confined to an approved root, including symlinks; compare/record/update are explicit modes.
`flow-report.ts` writes script-free self-contained HTML for every run. Per-step before/after capture is opt-in;
known secret text is redacted but screenshot pixels remain original.

## State on disk (`~/Library/Application Support/PhoneDock`, override with `PHONEDOCK_HOME`)
`daemon.json` (port/token/pid) · `state.json` (managed devices) · `avd/` (PhoneDock-owned AVDs, isolated
from `~/.android/avd`) · `qemu/<vm>/` · `ios-snapshots/` (APFS copy-on-write clones of simulator data) ·
`devices/<id>/actions.jsonl` · `device-claims.sqlite` (plus SQLite WAL/SHM files) · `requests/` (bounded input receipts) · `downloads/` · `bin/pd-ocr` · `logs/`.

## iPhone Duo simulator compatibility

Primary-display screenshots, UI reads, media import and recording work. AXe acknowledged input without effective
routing to the primary display; affected input is now rejected as `501 not_supported` / `not_sent` and removed
from per-device input capabilities. Use a single-display simulator for input tests. Streaming and system gestures
remain unvalidated on Duo.

## iPhones on iOS 27 and later

`ios-native.ts` runs one `tools/pd-ios-native.py` sidecar per phone (JSON lines over stdio, on pymobiledevice3).
Both native sidecars require Python 3.11+ for `asyncio.timeout`; the macOS system Python may be older. CI uses
Python 3.12 with `pymobiledevice3==11.49.2` and requires fake sidecar protocol tests.
It borrows the CoreDevice tunnel that macOS's `remoted` already keeps to the phone, by asking `remotepairingd` for
it (`NativeRemotedTunnel`); userspace tunnels are the fallback. Through that tunnel it uses `screencaptureservice`
(screenshots), the iOS 27 `remoteAXService` (the UI tree, read-only, in VoiceOver order; identifiers and types arrive
about 0.3 s after labels and frames), and `appservice`. Input lives in `ios-hid.ts` (`pd-ios-hid.py`):
`universalhidservice` plus `hid.indigo`, which iOS honours only while a screen stream is open. The stream is kept
alive with RTCP (the phone drops it after 20 s without) and closed after 45–60 s idle.

Historical measurements on iOS 27.0 over Wi-Fi (before these additions): connect ~1.6 s, screenshot 1–2 s, UI tree 1.1–1.8 s fresh, apps ~0.2 s,
input stream ~1.7 s to open and then ~50 ms per tap. `remoted` and PhoneDock evict each other's RSD control
connection but open service connections survive; failed reads can reconnect once. Mutations are not replayed after an uncertain result. iOS 27.0 doesn't implement
`getlockstate`, so `screenOn` comes from the backlight. The sidecar also has a cable-free Wi-Fi pairing
(`pair_wifi`) that isn't exposed yet, because it hasn't been tested on hardware. Automatic DDI mounting and a
single merged native/HID sidecar also remain unexposed.

The new native paths wire appearance, HID pinch, bounded logs and foreground lookup using the AX frontmost PID
joined to installed-app/process records. Missing or ambiguous matches throw `foreground_unknown`; only a
positively identified SpringBoard returns null. They have fake/contract tests; the changes have not been run on a real
iPhone. Both sidecars use shared Python discovery, including uv/pipx shell trampolines. Unicode clipboard payloads
travel over stdio instead of temporary plaintext files. Secret paste uses a tokenized clipboard transaction:
confirm insertion before restoring, preserve a newer clipboard, and report unknown delivery when paste cannot be
confirmed. These safeguards do not bypass an Allow Paste prompt.

Check dependencies with `phonedock doctor` (no phone contact), then diagnose an authorized known phone with
`phonedock doctor --device ios-device:<UDID>`. Python discovery belongs in `pymd3-python.ts`; reading only the first
shebang line is insufficient for uv/pipx shell trampolines.

## Experimental backends

These work but aren't part of the supported set; expect rough edges.

- **`qemu`**: any bootable OS image (ISO or qcow2), via upstream QEMU with Hypervisor.framework. Screenshots,
  typing, tapping and fast snapshots work; there's no in-guest agent, so no shell, app install or UI tree (OCR
  fills in). Mobile-Linux catalog images are x86_64 and run emulated, so they're slow.
- **`corellium`**: real iOS and Android firmware as cloud VMs, through Corellium's REST API. Written against the
  published API and untested without an account.

Details and measurements are in [RESEARCH.md](RESEARCH.md).
