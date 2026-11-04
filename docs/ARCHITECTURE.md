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
  can force a takeover from the dashboard at any time. Every action is appended to a per-device JSONL log
  (visible in the app's Activity tab and replayable).
- **Accessibility first, vision second.** `/ui` returns the accessibility tree (uiautomator, AXe, the iOS 27
  remote accessibility service, or WebDriverAgent) with short refs (`e12`) the agent can tap; when it's empty,
  macOS Vision OCR produces text elements with tap-ready centers. Screenshots are always available for visual
  reasoning.
- **Reuse, don't rebuild.** Android Emulator (QEMU + HVF), adb, scrcpy, ffmpeg, CoreSimulator/simctl,
  AXe (simulator HID + accessibility), devicectl and Apple's CoreDevice services, pymobiledevice3, WebDriverAgent,
  upstream QEMU, the MCP SDK.

## State on disk (`~/Library/Application Support/PhoneDock`, override with `PHONEDOCK_HOME`)
`daemon.json` (port/token/pid) · `state.json` (managed devices) · `avd/` (PhoneDock-owned AVDs, isolated
from `~/.android/avd`) · `qemu/<vm>/` · `ios-snapshots/` (APFS copy-on-write clones of simulator data) ·
`devices/<id>/actions.jsonl` · `downloads/` · `bin/pd-ocr` · `logs/`.

## iPhones on iOS 27 and later

`ios-native.ts` runs one `tools/pd-ios-native.py` sidecar per phone (JSON lines over stdio, on pymobiledevice3).
It borrows the CoreDevice tunnel that macOS's `remoted` already keeps to the phone, by asking `remotepairingd` for
it (`NativeRemotedTunnel`); userspace tunnels are the fallback. Through that tunnel it uses `screencaptureservice`
(screenshots), the iOS 27 `remoteAXService` (the UI tree, read-only, in VoiceOver order; identifiers and types arrive
about 0.3 s after labels and frames), and `appservice`. Input lives in `ios-hid.ts` (`pd-ios-hid.py`):
`universalhidservice` plus `hid.indigo`, which iOS honours only while a screen stream is open. The stream is kept
alive with RTCP (the phone drops it after 20 s without) and closed after 45–60 s idle.

Measured on iOS 27.0 over Wi-Fi: connect ~1.6 s, screenshot 1–2 s, UI tree 1.1–1.8 s fresh, apps ~0.2 s,
input stream ~1.7 s to open and then ~50 ms per tap. `remoted` and PhoneDock evict each other's RSD control
connection but open service connections survive; a failed call reconnects once. iOS 27.0 doesn't implement
`getlockstate`, so `screenOn` comes from the backlight. The sidecar also has a cable-free Wi-Fi pairing
(`pair_wifi`) that isn't exposed yet, because it hasn't been tested on hardware.

To check a phone from a source checkout:

```sh
PY=$(head -1 "$(which pymobiledevice3)" | cut -c3-)  # pymobiledevice3's own python
printf '{"id":1,"cmd":"status","args":{"refresh":true}}\n{"id":2,"cmd":"shutdown"}\n' \
  | "$PY" -I tools/pd-ios-native.py --udid <UDID>
```

## Experimental backends

These work but aren't part of the supported set; expect rough edges.

- **`qemu`**: any bootable OS image (ISO or qcow2), via upstream QEMU with Hypervisor.framework. Screenshots,
  typing, tapping and fast snapshots work; there's no in-guest agent, so no shell, app install or UI tree (OCR
  fills in). Mobile-Linux catalog images are x86_64 and run emulated, so they're slow.
- **`corellium`**: real iOS and Android firmware as cloud VMs, through Corellium's REST API. Written against the
  published API and untested without an account.

Details and measurements are in [RESEARCH.md](RESEARCH.md).
