# PhoneDock daemon HTTP API (v1)

The daemon (`phonedockd`, `node src/daemon/main.ts`) listens on `127.0.0.1:${PHONEDOCK_PORT:-47420}`.
On start it writes `$PHONEDOCK_HOME/daemon.json` (`daemon-<port>.json` when `PHONEDOCK_PORT` is not 47420) = `{ "port": 47420, "token": "<hex>", "pid": 123, "version": "0.1.0", "startedAt": "…" }`
(`PHONEDOCK_HOME` defaults to `~/Library/Application Support/PhoneDock`). File mode 0600.

`PHONEDOCK_DEVICE_FILTER=<prefix>` (optional) limits a daemon to devices whose name starts with `<prefix>`: other devices aren't listed and requests for them return `not_found`, create/clone/rename require the prefix (`bad_request`), and physical-phone routes (`/v1/connect`, `/v1/pair`, `/v1/ios/discover`, `/v1/ios/wda-setup`) return `not_supported`. Use it for tests and CI on a Mac with devices they must not touch.

**Auth:** every request except `GET /v1/health` needs `Authorization: Bearer <token>` (or `?token=` for
`<img>`/MJPEG URLs). **Agent identity:** clients send `X-PhoneDock-Owner: <name>` (e.g. `claude-code:1234`, `app:human`).

**Errors:** non-2xx responses are JSON `{ "error": { "code": "not_found", "message": "…", "hints": ["…"], "detail": "…" } }`. `detail` is optional and contains diagnostic information, such as a command and its output; `message` and `hints` are intended for people.
Errors from input routes also carry `delivery` and `retrySafe` (added; see *Delivery* under *Input & control*).
Codes worth handling: `not_found` 404 (also "no element/field matches"; hints carry a one-line screen summary),
`not_supported` 501 (backend lacks the feature), `lease_conflict` 409, `stale_ref` 409, `wait_timeout` 408
(hints: what is on screen / still visible / still moving), `handoff_pending` 409, `handoff_resolved` 409,
`recording_active` 409, `not_recording` 409, `trace_active` 409, `not_tracing` 409, `bad_request` 400, `no_prompt` 404, `needs_human` 403,
`no_button` 404, `ambiguous_button` 409, `gesture_failed` 500, `delivery_unknown` 502 (added: an Android input whose
reply from the on-device helper was lost; it may have happened, and it is never sent again by the daemon).

**Device ids** are `${backend}:${nativeId}` and must be URL-encoded in paths (`encodeURIComponent`).
All coordinates are device screenshot pixels (see `src/core/types.ts`). (The MCP server has its own fixed agent space,
the pixels of a standard 1024 px screenshot, and converts: see `docs/AGENTS-GUIDE.md` §2.)

## Service
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | /v1/health | – | `{ ok, version, pid, uptimeSec }` |
| GET | /v1/backends | – | `[{ id, displayName, stage, platform, kind, capabilities, availability: {ok, reason, hints, version} }]`; `stage` is `stable`, `beta` or `experimental` (show a badge unless `stable`; older services omit it, which means `stable`) ; `?debug=1` → `{ backends, failures, streams, screenSources }` (modules that failed to load; live streams with `kind`, `viewers`, `hasFrame`, `ageMs`, `firstFrameMs`, `fallbackCaptures`; see *Live video*) |
| GET | /v1/backends/:backend/images | – | `OsImage[]` = `[{ id, backend, platform, name, version?, installed, usable?, profiles?, sizeMB?, notes? }]`. `usable: false` = installed but can't create devices on this Mac, with `notes` saying why. iOS simulator: the runtime's disk image isn't `Ready` (`simctl runtime list`), creating a simulator on that runtime build failed with "runtime is not available" (remembered until a create on it succeeds), or a throwaway probe create fails. Creating a device without `image` skips such runtimes. `profiles` lists the HardwareProfile ids it can run (absent = all) |
| POST | /v1/backends/:backend/images/install | `{ image }` | `Job` (long-running; poll `/v1/jobs/:id`) |
| GET | /v1/backends/:backend/profiles | – | `HardwareProfile[]` |
| GET | /v1/jobs/:id | – | `Job` = `{ id, kind, state: 'running'|'done'|'failed', progress: string[] (last 50 lines, each starting with the Mac's local time `HH:MM:SS`), result?, error?: { code, message, hints?, detail? }, startedAt, endedAt? }` |
| GET | /v1/jobs | – | `Job[]` (recent) |
| GET | /v1/events | – | SSE stream: `event: device` (Device JSON), `event: job` (Job), `event: lease`, `event: action`, `event: handoff` (full `Handoff` on every create/resolve/timeout), `event: recording` (`{ deviceId, active: true, path, startedAt, maxSeconds }` on start; `{ deviceId, active: false, path, sizeBytes, durationSec, autoStopped?, warning?, reason? }` on stop), `event: trace` (see Performance traces) |

## Devices
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | /v1/devices | `?backend=&platform=&state=` | `Device[]` (all backends, managed + discovered). `osVersion` is display text: `Android 16 (API 36)`, `iOS 26.5 (23F77)` (iOS simulators said `26.5` before) |
| POST | /v1/devices | `DeviceSpec` (+ `boot?: boolean`) | `202 { job, device? }` – creation is a Job; `job.result` is the Device |
| POST | /v1/devices/batch | `{ spec: DeviceSpec, count, boot? }` | `202 { jobs: Job[] }` – names get `-1..-N` suffixes |
| GET | /v1/devices/:id | – | `Device` |
| PATCH | /v1/devices/:id | `{ name?, autoStart? }` | `Device` |
| DELETE | /v1/devices/:id | `?force=1` | `{ ok }`. Managed devices only, and `409 lease_conflict` while someone else holds its lease, unless `force` (deletes it anyway; `phonedock rm --force`) |
| POST | /v1/devices/:id/boot | `BootOptions` | `202 { job }`. Android emulators PhoneDock created get Chrome's first-run screens skipped at boot: `/data/local/tmp/chrome-command-line` = `_ --disable-fre --no-default-browser-check --no-first-run` and Chrome's notification permission granted, once (an existing file is left alone; never on AVDs PhoneDock didn't create) |
| POST | /v1/devices/:id/shutdown | – | `{ ok }`. The device reads `state: "stopping"` from the moment the call starts; its lease ends with the shutdown |
| POST | /v1/devices/:id/restart | `BootOptions` | `202 { job }` (shut down if running, then boot) |
| POST | /v1/devices/:id/clone | `{ name }` | `202 { job }` (result = new Device) |
| POST | /v1/devices/:id/window | – | `{ ok }` opens native viewer (Simulator.app / emulator window / scrcpy) |
| GET | /v1/devices/:id/snapshots | – | `Snapshot[]`. Never lists the emulator's internal `default_boot`; `sizeMB` is the size on disk, stable between calls. Errors: `snapshot_vulkan` (Android emulator can't save after a Vulkan app ran), `snapshot_incompatible`, `snapshot_failed` (e.g. the phone isn't running after a restore) |
| POST | /v1/devices/:id/snapshots | `{ name }` | `{ ok }` |
| POST | /v1/devices/:id/snapshots/:name/restore | – | `{ ok }` |
| DELETE | /v1/devices/:id/snapshots/:name | – | `{ ok }` |
| GET | /v1/devices/:id/info | – | backend-specific JSON |
| GET | /v1/devices/:id/screen | – | `ScreenInfo` |

`Device.handoff` is the device's **pending** `Handoff` (see below) or `null`; a `device` SSE event fires when it changes.

`Device.screen` (`ScreenInfo` = `{ width, height, scale, orientation? }`) is the screen as it is now, in screenshot
pixels: width and height swap when the screen turns. `Device.orientation` (`'portrait' | 'landscape'`) is derived
from it. Both are known for every running device: the daemon reads the screen once a device is running (also after
a snapshot restore, a reboot or a daemon restart) and again every 10 s while its live view is open, so a device
that an app turns by itself is noticed; a `device` SSE event fires when the size changes. iOS simulators remember
their screen size across shutdowns, so a stopped one still has `screen` (in portrait).

## Observation
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | /v1/devices/:id/screenshot | `?format=png|jpeg&maxSize=1024&quality=70` | image bytes. Headers: `X-Device-Width`, `X-Device-Height` (full-res px), `X-Image-Width`, `X-Image-Height`, `X-Scale` (= device px / image px) |
| GET | /v1/devices/:id/stream | `?maxSize=720&fps=15&token=` | `multipart/x-mixed-replace; boundary=frame` MJPEG |
| GET | /v1/devices/:id/frame | `?maxSize=720`, optional `If-None-Match` | latest JPEG frame from the live stream (starts the stream if needed; falls back to screenshot). Responses include `ETag`; a matching validator returns 304 with no body. `X-Frame-Source` is `stream` or `screenshot`. Stream frames carry `X-Device-Width`/`X-Device-Height`: the screen size the frame shows, which changes the moment the device turns (use it, not an earlier `Device.screen`, to map clicks on that frame). Until the stream's first frame (a new stream gets 250 ms), the screenshot fallback is shared by concurrent requests and refreshed at most once a second, so polls in between get the same `ETag` (and 304). |
| GET | /v1/devices/:id/video | `?maxSize=1280` (160–4096) | `application/vnd.phonedock.video`: the screen as H.264 or HEVC straight from the device's encoder, framed (see *Live video*). Devices that have it list `video` in their capabilities (Android emulators and phones: H.264; iPhones on iOS 27+: HEVC); `501 not_supported` elsewhere |
| GET | /v1/devices/:id/ui | `?format=json|text&ocrFallback=1&partialOcr=1` | json: `UiTree` + `prompt: SystemPrompt \| null` (see *System prompts*); text: compact outline, one element per line: `e12 Button "Sign in" @(540,1210) [w×h]`, plus a `# prompt: …` line after the header when a prompt is on screen. See *Partial trees* below |
| POST | /v1/devices/:id/find | `{ text?, id?, type?, match?: 'contains'\|'exact'\|'regex', index?, limit?: 20, ocrFallback?: true }` (≥1 of text/id/type) | `{ source, total, index, match: ElementMatch \| null, matches: ElementMatch[], screen, capturedAt, ocrTried, ocrError?, summary?, scrollable? }` (`ocrError`: why the OCR fallback could not run). With no match: `summary`, and `scrollable` = can anything on this screen scroll (`true`/`false`; `null` = unknown: iOS, OCR, webviews), so a client only suggests scrolling when it can help |
| GET | /v1/devices/:id/focus | `?waitMs=0` (≤10000; polls until a field is focused or a keyboard is up) | `{ known, ok, focused: ElementMatch \| null, keyboard, elapsedMs, reason? }`. `known: false` (with `reason`) when the device can't tell: the iOS simulator's tree has no focus flag, so with a hardware keyboard (no on-screen keyboard) focus is unknown, not absent |
| GET | /v1/devices/:id/appearance | – | `{ appearance: 'dark'\|'light'\|'unknown' }` |
| POST | /v1/devices/:id/appearance | `{ appearance: 'dark'\|'light' }` (`mode` also accepted) | `{ ok, appearance, previous, changed }`. System-wide Dark Mode: iOS simulator `simctl ui appearance`, Android `cmd uimode night yes\|no`. Needs the lease like other input; `501` on backends without it (capability `appearance`) |
| POST | /v1/devices/:id/wait | `{ until: 'visible'\|'gone', text?, id?, type?, match?, timeoutMs?: 10000, intervalMs?: 300, stableMs?: 0 }` | `{ ok, until, elapsedMs, polls, source, match?, matches? }` – `408 wait_timeout` otherwise |
| POST | /v1/devices/:id/wait | `{ until: 'idle', timeoutMs?, intervalMs?: 200, stableMs?: 1000 }` | `{ ok, until, elapsedMs, frames, changes, stableMs, changedRegion }` – screen unchanged for `stableMs` |

### Live video

`GET /v1/devices/:id/video` streams the screen as video at the device's own frame rate (up to 60 fps), for a viewer
that decodes H.264 or HEVC (the Mac app decodes both in hardware). It is one long response: a sequence of messages, each a
16-byte header and a payload.

| Offset | Size | Field |
|---|---|---|
| 0 | u8 | type: 1 `screen`, 2 `config`, 3 `frame`, 4 `state`, 5 `reset`, 6 `ping`, 7 `still` |
| 1 | u8 | flags: `frame` 1 = key frame, 2 = replay (decode, don't show); `config` the codec (0 H.264, 1 HEVC) |
| 2 | u8 | version (1) |
| 3 | u8 | reserved (0) |
| 4 | u32 BE | payload length |
| 8 | u64 BE | timestamp, µs since the Unix epoch: `frame` when the Mac got it, `still` when it was taken, `ping` and the error `state` when sent, else 0 |

| Type | Payload |
|---|---|
| `screen` | JSON `{ width, height, videoWidth, videoHeight, rotation, orientation, density, codedWidth?, codedHeight? }`: the screen in screenshot pixels (map clicks with it) and the video's size. Sent first and whenever the screen turns or the video changes size. `codedWidth`/`codedHeight` (iPhones): the decoded picture is larger than the video (padded, e.g. 1328x2896 for 1320x2868) and its SPS doesn't say so; show only its top-left `videoWidth` x `videoHeight` |
| `config` | the codec's parameter sets (H.264 SPS + PPS, HEVC VPS + SPS + PPS), Annex B. Before the first frame and whenever they change (a new encoder, an iPhone turning) |
| `frame` | one access unit (one picture), Annex B, without parameter sets |
| `state` | JSON `{ state: 'live' \| 'asleep' }`: `asleep` while the display is off (no frames come; show the screen black). Last, before the server ends the stream for good: `{ state: 'error', code, message }` (the device can't stream; fall back to `/frame`) |
| `reset` | empty: throw away the decoder's state; a `config` and a key frame follow |
| `ping` | empty, after a second without anything else: the connection is alive on a still screen |
| `still` | a PNG of the screen, when a new viewer has no frame 250 ms after it connected (the device's encoder is still starting); show it until the first frame |

* **Joining.** A viewer gets `screen`, `state`, `config`, then the last key frame and every frame since, all but the
  last marked replay, so it shows the current picture at once, also on a still screen (the encoder sends nothing
  while the screen doesn't change). The daemon keeps that run short: after 1.5 s of stillness with a long run since
  the key frame, it starts a fresh encoder whose first picture is a key frame (the switch is seamless: the new one
  takes over at its first picture).
* **One capture per device**, shared by every `/video` viewer of that size and by `/frame` and `/stream` (which
  transcode it to JPEG; the transcoder only runs while they have viewers). It stops 5 s after its last viewer leaves,
  so a viewer that comes back within that time starts with no delay.
* **Slow viewers** never make the daemon buffer without bound: a viewer more than a couple of MB behind skips
  frames until it has caught up, then gets `reset` and starts again from the last key frame. Frames are never
  throttled otherwise.
* **Android:** `adb exec-out screenrecord --output-format=h264`, its longer side the largest `maxSize` its viewers
  asked for (8 Mbit/s above 1000 px, 6 below), `--time-limit 0` on Android 14 and later (older ones get a new
  encoder before the 3-minute limit, seamlessly). A rotation restarts it at the new size (`screen`, then a new
  `config` and a key frame; viewers keep the last picture meanwhile, about half a second). screenrecord stops while
  the display is off: `state: asleep`, and it starts again by itself when the display comes back.
* `GET /v1/backends?debug=1`: `streams` entries have `kind: 'jpeg' | 'video'` (video ones also `frames`,
  `cachedFrames`, `cachedBytes`, `dropped`, `resyncs`); `screenSources` lists the Android captures (`encoders`
  started, `handovers`, `restarts`, `repairs` of split pictures, `frames`, cache size).
* The Mac app uses `/video` for devices with the `video` capability and falls back to polling `/frame` when it gets
  404/501, the stream ends with an error, or three connections in a row bring no frame (`PHONEDOCK_VIDEO=0` in the
  app's environment: JPEG frames only).

**Matching** (`/find`, `/wait`, `/fill`, MCP `tap text=`): case-insensitive over text, label, value, placeholder and id
(`match` = contains, exact or regex); `type` matches the role ("Button", "TextField", …). One `/ui` read, so refs in
the result are valid for `tap {ref}`. Ranking: exact (+4) › clickable (+2) › visible (+1), then enabled, then tree
order; on-screen keyboard keys never match text. `ElementMatch` (`src/core/types.ts`) = `{ ref?, type, text?, label?,
id?, value?, placeholder?, bounds, center, clickable?, enabled?, focused?, checked?, editable?, visible, exact, score, source, coveredBy? }`.
`center` is the **tap point**: for a toggle row it is the switch inside it. `visible` = centre on screen and not
under the software keyboard. `coveredBy` (added; iOS): a bar floating over the content at the bottom (the search field
of iOS 26 Settings with its glass, a tab bar) covers the element's centre, e.g. `the floating "Search" field`; `center`
is then the middle of its part above the bar, and `visible` is false when less than 12 px of it shows. When the tree is missing or empty, or a text query matches nothing, the daemon OCRs a
screenshot (`source: 'ocr'`, no refs, `type` ignored). OCR reads whole lines: when the text matches only part of a
line (`"Terms"` in `"I agree to the Terms and Privacy Policy"`), `center` is the middle of the matched words and
`bounds` stays the line's. A match on the whole line taps the line's centre.

**Placeholders.** `UiElement.placeholder` is a text field's hint (Android `hint`, shown while the field is empty).
When it is set, `text`/`value` hold only what was typed, so an empty field has no `text`; the text outline shows
`EditText id=nameField placeholder="Your name" (empty)`. On Android the helper also reports which fields are showing
their hint, so typed text that equals the hint is still a value. AXe (iOS simulator) has no placeholder field: an empty
iOS field still reports its placeholder as `value` (see `/fill`).

**Windows (Android, added).** A UI read describes the window the person is using: the focused window when it is
an app, a system dialog or the pulled-down notification shade; else the active window; else the topmost app window.
(Before, Android described the "active" window, which during a heads-up notification could be SystemUI's
notification shade: its tree spans the screen and holds the collapsed Quick Settings, so `/scroll-to` swiped in
`expanded_qs_scroll_view`.) Everything else on screen is listed in `UiTree.windows?: UiWindow[]`, top first:
`{ role, bounds, package?, title?, focused?, described?, texts? }`, where `role` is `app` | `dialog` | `keyboard` |
`notifications` | `heads_up` | `pip` | `system`, `described: true` marks the window the elements come from, and
`texts` holds up to 6 texts of an overlay that is not described (a heads-up's app, time, title and text); `bounds`
is the window's part on screen. Status and navigation bars and accessibility overlays are left out. The text
outline adds a line after the header for what covers the described window and is not in the list, e.g.
`# Over the screen: heads-up notification: "Messages · now · Kim: on my way"; keyboard from y=1500`, or for a
small system window (vivo's edge card) `system window (com.vivo.card) @(1044,345) 72x306`. The keyboard's bounds also feed `/focus` (`keyboard`) and the
keyboard-avoiding swipes. Only reads through the on-device helper have `windows`; the `uiautomator dump` fallback
describes the active window as before. Other platforms leave `windows` out.

**Element types.** iOS switches (AXe reports `CheckBox` with subrole `AXSwitch`) have the type `Switch`.

**Partial trees.** Some screens expose rows with no accessibility content: iOS Settings › Developer's "Dark Appearance"
and "Enable UI Automation" rows are empty `Group`s, and a WebView can appear before its page is exposed. The iOS
simulator backend first asks AXe for the element at each empty row's centre (`describe-ui --point`, in parallel, about
0.25 s), which fills such rows with the real control: `Switch "Dark Appearance" [off]`, tapped on its switch
(`PHONEDOCK_IOS_POINT_QUERY=0` turns this off). When `/ui` still finds a gap (an empty, row-sized iOS container, or a WebView with no text inside), it OCRs one screenshot and adds
the lines inside the gaps as `Text` children with `ocr: true` and fresh refs (tappable, matched by `/find` and
`/wait`); the text outline marks them `[ocr]` and adds a header line. `UiTree.ocr = { regions, merged, ms, error? }`
says what was done. A complete tree costs nothing extra; a merge adds about 0.5 s. `partialOcr=0` (or
`ocrFallback=0`) turns it off.

**Idle** compares 64 px greyscale thumbnails: a frame counts as changed when more than max(4 cells, 0.05%) differ, so
a blinking caret or a status-bar clock tick doesn't count; a spinner, video or animation does.

## Input & control
| Method | Path | Body | Response |
|---|---|---|---|
| POST | /v1/devices/:id/input | `InputAction` or `{ actions: InputAction[] }`, plus optional `expect` (see *expect*) | `{ ok, resolved?, delivery, retrySafe, expect? }` (`tap` with `ref` resolves to the tap point of the element from the last `/ui`/`/find`, found again on a fresh read of the screen first (see *Tap by ref*; `resolved.moved`, `resolved.refCheck`, or `409 stale_ref` with nothing tapped), above a floating bar that covers its centre: then `resolved.coveredBy`, and `resolved.hidden: true` when nothing of it shows above the bar. Android: when the on-screen keyboard is up and its window covers the point of an element tap (`ref`, or `x`,`y` with `label`), it is hidden first and `resolved.keyboardHidden: true` (in landscape Gboard covers the whole app). A bare `x`,`y` is tapped as is, keyboard or not. `tap` with `x`,`y` takes an optional `label`, the name of what was aimed at, plus optional `selector: { text?, id?, type?, match?, index? }` (the find query that chose the point) and `element: { type?, id?, editable? }`; all three only appear in the activity log, and `flow save` turns `selector` into `tap: <text>`) |
| POST | /v1/devices/:id/fill | `{ value, text? \| id? \| type? \| ref? \| x?,y?, match?, index?, clear?: true, submit?: false, secret?: false, focusTimeoutMs?: 2000, expect? }` | `{ ok, via, element, label?, tapped, moved?, refCheck?, focused, keyboard, cleared, clearMethod, previousValue, finalValue, finalLength, verified, secret, submitted, warnings[], elapsedMs, delivery, retrySafe, expect? }` (`moved`, `refCheck`: added, `ref` fills, as for `tap {ref}`) |
| POST | /v1/devices/:id/keyboard/hide | – | `{ ok }` |
| GET | /v1/devices/:id/actions | `?limit=200` | recorded action log `[{ at, owner, action }]` |
| POST | /v1/devices/:id/replay | `{ actions: {action, delayMs?}[] }` | `202 { job }`; `job.result` = `{ ok, steps, skipped, warnings }` |
| POST | /v1/devices/:id/lease | `{ owner, ttlSec?, force? }` | `Lease` = `{ owner, acquiredAt, expiresAt, ttlSec?, stale?, preempted?, reclaimedFrom? }` (`409 lease_conflict` if held by someone else and not `force`). `preempted: { owner, ttlSec?, at }` on an `app:human` lease: the agent the person took the device from. `reclaimedFrom` (in this response and `/v1/pool/acquire`'s only) = the owner of the stale lease this one replaced |
| DELETE | /v1/devices/:id/lease | – | `{ ok, released, heldBy?, note?, returnedTo? }`. When `app:human` releases (Hand Back), the device goes back to the agent it was taken from if that session is still alive (`returnedTo`); if the agent has gone, it's released and `note` says so. Releasing a lease you don't hold is **not** an error: `released: false`, `heldBy` names the holder and nothing changes |

**Leases.** Input/app/shell calls from an owner that doesn't hold an active lease return `409 lease_conflict`. No
lease = anyone may act. `force: true` from `app:human` = the app's **Take Over**.
* **Lifetime.** Agent leases without `ttlSec` last 10 minutes (`ttlSec: 600`), and every call the owner makes on
  that device (input, `/ui`, screenshots, anything under `/v1/devices/:id`) restarts that time, so an agent that
  is working keeps its device and one that went quiet frees it. `app:human` leases have no TTL: they last until
  the person hands the device back.
* **Stale owners.** Owners `mcp:<client>:<pid>` and `sdk:<pid>` carry their process id. If that process has exited,
  the lease shows `stale: true`, and the next request from anyone else reclaims it and goes through. The daemon
  logs `reclaimed the lease on … from … for …: that process has exited` and records a `lease.reclaim` action.
  Owners without a pid (`cli:<user>`, custom names) are never reclaimed this way; wait for the TTL or `force`.
* **`lease_conflict`** says who holds the device and what to do. If a person holds it, the agent should wait for
  them to hand it back or ask them with a handoff. Taking over from a person is not offered. If another agent
  holds it, wait (its lease ends N minutes after its last call) or ask the person. While a handoff is pending
  a hint names it. `detail` gives the lease's start and end.
* **Activity log** (`GET /actions`, the app's Activity tab): lease and handoff events are recorded alongside input,
  as `{ action: 'lease.acquire' | 'lease.release' | 'lease.take_over' | 'lease.hand_back' | 'lease.returned' |
  'lease.reclaim' | 'lease.expired', previousOwner?, … }` and `handoff.*` (see *Human handoff*). `take_over` /
  `hand_back` are `app:human`'s acquire / release (`hand_back` adds `returnedTo` and `summary: "Handed back to Claude Code"`, or `previousAgent` when the agent had quit). Added events: `device.start`, `device.shutdown`,
  `device.restart`, `device.crashed`, `device.disconnected`, `*_failed` for start / shutdown / restart, and `snapshot.save_failed` / `snapshot.restore_failed`
  (each with `error`). Taps, long presses, double taps and pinches carry `where` ("near the top right") and, when the element is known, `label`, next to the raw x/y.
  `/replay` only replays input actions.

**InputAction additions:**
* `{ action: 'doubleTap', x, y }`: falls back to two taps 80 ms apart, with `resolved.fallback: 'two taps'`.
* `{ action: 'pinch', x, y, scale, durationMs?: 400 }`: `scale` < 1 pinches in, > 1 spreads.
* `{ action: 'type', text, secret: true }`: logged as `{ action:'type', text:'•••', length, secret:true }`. `/replay`
  skips secret steps (a `'•••'` text counts as secret), and lists them in `skipped` and `warnings`.

**Tap by ref (changed).** A ref names an element of the last tree read on the device (`/ui`, `/find`, `/wait`,
`/scroll-to`), and the screen may have changed since: a keyboard closed and the layout moved, a list scrolled, a row
was inserted. The old coordinates would then hit something else. So `tap {ref}` and `/fill {ref}` read the screen
again (the same cleaned tree as `/ui`; OCR when the ref came from OCR text) and find the element there first
(`src/daemon/refcheck.ts`):
* **Same element** = same type, text, label and id; for a text field the placeholder instead of the text (typing
  changes the text); a switch's `checked` state; an unlabelled element (type only) also about the same size. OCR
  lines: the same text. When several elements look alike in either read (a Like heart under every comment), only
  those whose nearest surrounding words still match stay candidates: the words of the ancestor that tells the
  element apart (its row), or, in a flat tree (an iPhone without WDA), the words on its line.
* **Where it is.** A candidate whose tap point is within 2% of the screen's shorter side (at least 8 px) of the old
  one is tapped where it is now. Otherwise, if exactly one candidate is left, it is tapped at its new place and the
  result says so: `resolved.moved: { from: {x,y}, to: {x,y} }` (added; the point the old read gave, the point
  tapped; also in the activity log). Otherwise nothing is tapped: `409 stale_ref`, "The screen changed since it was
  read, so PhoneDock didn't tap: read the screen again", with `detail` naming the element, where it was, how many
  look-alikes there are now and where, and what a tap at the old point would hit now. Also refused: the element moved
  off the screen; its switch flipped; the text around a look-alike changed (a refusal is far cheaper than a tap on
  someone else's comment).
* **Android keyboard.** When the keyboard covers the element it is hidden first (`resolved.keyboardHidden`), and
  the screen is read and the element found again after that, since hiding it can move the layout too.
* **Cost.** `resolved.refCheck: { via, ms }` (added) says how it was checked: `recent` (the tree the ref came from is
  under 300 ms old with no input since: no read), `joined` (a read already in flight, e.g. another `/ui`, started
  after the last input), `read` (a new read), `ocr` (a new OCR read), `unchecked` (see below). A read costs what a
  `/ui` costs: on Android with the helper ≈40–120 ms on a still screen (while the screen is still moving it first
  waits for 500 ms without changes, at most 5 s, which is what you want here; ≈2 s with `uiautomator dump`); iOS
  simulator ≈0.1–0.5 s; an iPhone on iOS 27 without WDA 1.1–1.8 s; OCR a screenshot plus recognition.
* **No new read.** When the screen can't be read again (the read fails, or OCR is unavailable), a ref from a tree
  under 1.5 s old is tapped as before, unchecked (`refCheck.via: 'unchecked'`); an older one is refused with
  `stale_ref`. A backend without a tree serves its refs from OCR, so the check reads OCR again.
* Refs still resolve against the last tree read on the device, by any client or by the daemon itself (`expect`,
  `/fill`, `/wait`), and still go stale with every input; `stale_ref` also means "no tree read yet" and "unknown
  ref", as before. The check's own read never replaces that tree.

**Delivery (added).** Every input route (`/input`, `/fill`, `/scroll-to`, `/swipe`, `/back`, `/gesture`,
`/apps/:appId/launch`) says how far the input got, in its result and in its error JSON:
* `delivery: 'sent'`: something reached the device (`retrySafe: false`).
* `delivery: 'not_sent'`: nothing did: a bad request, a lease conflict, an unknown device or key, adb could not
  reach the device, or (results only) the route needed no input, e.g. `/scroll-to` found its target without
  scrolling. `retrySafe: true`: the only case where sending the same request again is safe.
* `delivery: 'unknown'`: it may have reached the device (a lost helper reply, adb breaking mid-command, a timeout).
  Read the screen before sending it again.

A batch that fails part way is `sent`. The SDKs expose it on errors (`PhoneDockApiError.delivery` / `retrySafe`,
Python `.delivery` / `.retry_safe`). They resend an input request only when the connection was refused (the daemon
wasn't running: nothing was sent); a connection that broke after the request went out is a `daemon_unreachable`
error with `delivery: 'unknown'`, never a resend.

**`expect` (added).** `/input`, `/fill`, `/swipe` and `/apps/:appId/launch` take an optional `expect`, checked once
after the input (after the last action of a batch): `{ visible: text }` | `{ gone: text }` | `{ id: id }` |
`{ changed: true }`, plus `match?: 'contains'|'exact'|'regex'` (default contains, as in `/find`) and
`timeoutMs?: 5000` (≤ 60000). A string is short for `{ visible: string }`. Unknown keys or more than one kind are
`400 bad_request` (nothing sent). The result gains `expect: ExpectReport` = `{ ok, outcome, expected, message,
elapsedMs, polls, changed, wasThere?, match?, summary? }`:
* `outcome: 'verified'`: e.g. `Verified: "Welcome" is on screen (0.4 s).` When the text was already on screen
  before the input, the check waits for the screen to change and still shows it; if it never changes it is
  verified with `…, but it was already there before the input and the screen did not change`.
* `'screen_unchanged'`: `Not verified: the screen did not change in 5.0 s; "Welcome" is not on it.` The input
  probably missed.
* `'changed_not_found'`: `Not verified: the screen changed, but "Welcome" never appeared (5.0 s).` It did something
  else: read the screen.

`changed` compares a digest of the tree's texts, values and states (not positions; status and navigation bars and
the keyboard left out) before and after; `null` when it could not be told (no tree). The "before" is the last
`/ui` read when it was taken after the last input and is under 15 s old, else a fresh read (about 0.1–0.5 s). Polls
every 300 ms, like `/wait`; `summary` (when not verified) is a one-line screen summary. An unmet `expect` is still
a 200: the input was sent (`delivery: 'sent'`), so don't resend it blindly. CLI: `--expect TEXT|visible:T|gone:T|
id:ID|changed`, `--expect-timeout MS`, `--expect-match M` on tap, long-press, double-tap, swipe, type, key, fill,
launch and input (exit 1 when not verified). MCP: `expect` on tap, long_press, double_tap, swipe, type_text, fill,
press_key and launch_app (also inside `batch`).

**Android input path (changed).** Taps, double taps, long presses, swipes, drags, keys and ASCII text are injected
by the on-device helper when its session is up (a UI read or an earlier input starts it), with the input manager
as `cmd input` does (UiAutomation if that is refused), on the helper's open `adb shell` instead of a new one per
call: a tap went from ~50 to ~20 ms on the emulator and from ~120 to ~45 ms on a phone over Wi-Fi. Drags queue
their moves without waiting for each frame, so a `/scroll-to` of 5 scrolls takes ~7–8.5 s instead of ~10–12 s. Each command is written once and
answered `sent` / `notsent` / `unknown`; `unknown` is the `delivery_unknown` error, never retried. Without a session,
or when the helper reports nothing was injected, the input goes through `adb shell input` as before. Non-ASCII text
still uses the clipboard and paste, without the system's "Copied" preview (Android 13+). `PHONEDOCK_ANDROID_HELPER=0` turns the helper off;
`PHONEDOCK_ANDROID_HELPER_INPUT=0` keeps it for UI reads only. `Backend.drag?(nativeId, x1, y1, x2, y2, durationMs,
holdMs)` (added, optional) is the hold-before-lift drag `/scroll-to` uses.

**`/fill`**
1. Finds the field: text/id/type with editable fields preferred. If the match is a label, it uses the nearest
   editable element. A `ref` (found again on a fresh read first, like `tap {ref}`: `moved`, `refCheck`, or
   `409 stale_ref` with nothing tapped) or a point also works. When `text` matches nothing but is exactly a field's id (its
   short form, `nameField`, as `/ui` prints it), that field is used (`via: 'id'`). With no match, the `404
   not_found` hints list the text fields on screen with their refs and ids.
2. Taps it. On iOS it taps near the right end so the caret lands after the existing text.
3. Waits up to 2 s for focus or a keyboard. If neither appears it adds a warning and types anyway. An iOS simulator
   that typed and verified a fill with no on-screen keyboard is remembered as using a hardware keyboard (AXe's HID
   typing makes the simulator assume one): later fills on it read the screen once instead of waiting. Seeing a
   software keyboard again forgets that.
4. Clears the field (`clearMethod`):
   * Android: select all (Ctrl+A) then DEL, one shell call; if the text survives, MOVE_END plus n×DEL. An empty
     field (only its placeholder showing) isn't cleared at all.
   * iOS: Edit menu → Select All, so typing replaces the text. If no menu appears it holds the on-screen delete key.
     An edit menu offering only Paste or AutoFill means the field is already empty. With no on-screen keyboard
     (hardware keyboard) it sends Cmd+A (`clearMethod: 'select all (Cmd+A)'`, the `select_all` key) so typing replaces
     the text; if the old text is still in front afterwards it falls back to n× delete and retypes. A field whose value
     is its placeholder, its label, or the label of the icon inside it (Settings' search field shows "Search", the
     magnifier's label) counts as empty: `clearMethod: 'already empty (placeholder)'`.
   * Elsewhere: n× delete key.
5. Types the value.
6. Re-reads the field and verifies it. If typing was dropped it retypes the missing part once.
7. With `submit`, presses Return: the on-screen key on iOS, Enter elsewhere.

`previousValue` and `finalValue` are masked (`••••`) when `secret` is set; `finalLength` is still exact. Empty iOS
fields report their placeholder as their value. The daemon learns each field's placeholder and treats it as empty.
On iOS the tap point stays left of in-field buttons (Dictate, clear) on the right of the field. When the device can't
report focus (iOS simulator with a hardware keyboard), fill types anyway and says so in `warnings`.
Each primitive step is logged with `via: 'fill'`. Typical timings: iOS simulator 3–5 s, Android emulator about 6 s.
The iOS simulator backend also takes `select_all` in `{ action: 'key' }` (Cmd+A over HID).

## Scrolling, system gestures & system prompts
| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | /v1/devices/:id/scroll-to | `{ text? \| id?, type?, match?, direction?: 'down'\|'up'\|'left'\|'right', maxScrolls?: 8 (0–50), x?, y?, durationMs?: 600, distance?: 0.6, ocrFallback?: true }` | `{ ok, found, element: ElementMatch \| null, scrolls, direction, endReached, reason?, source, elapsedMs, swipe, container, method?, note?, summary?, nothingToScroll?, keyboardHidden? }` |
| POST | /v1/devices/:id/swipe | `{ direction: 'up'\|'down'\|'left'\|'right', distance?: 0.5, durationMs?: 300, x?, y?, expect? }` | `{ ok, direction, swipe: {x1,y1,x2,y2,durationMs}, container, keyboardHidden?, elapsedMs, delivery, retrySafe, expect? }` – a direction swipe placed for you (see below). Explicit `x1,y1 → x2,y2` swipes stay `POST /input` |
| POST | /v1/devices/:id/back | – | `{ ok, method: 'key back'\|'nav bar back button'\|'left-edge swipe', tapped?: { ref, text, center }, elapsedMs }` – iOS taps a visible nav-bar `BackButton` (or a top "Back" button) before falling back to the edge swipe |
| POST | /v1/devices/:id/gesture | `{ gesture: 'go_home'\|'app_switcher'\|'control_center'\|'notification_center' }` | `{ ok, gesture, platform, method, elapsedMs }` – `501 not_supported` off Android/iOS |
| GET | /v1/devices/:id/prompt | `?ocrFallback=1` | `{ prompt: SystemPrompt \| null, source, capturedAt, text? \| summary? }` |
| POST | /v1/devices/:id/alert | `{ action: 'accept'\|'dismiss'\|'button=<label>', button?, verify?: true, settleMs?: 500, ocrFallback?: true }` | `{ ok, action, prompt, tapped: { text, ref?, role?, bounds, x, y }, dismissed, after, elapsedMs }` |

**`/scroll-to`** looks first (same matching and OCR fallback as `/find`), then swipes slowly and looks again, up to
`maxScrolls` times. `direction` is where to look: `down` reveals what is below (the finger moves up).
* **Keyboard.** On Android an on-screen keyboard is hidden first (`keyboardHidden: true`): a swipe that starts on
  Gboard glide-types into the focused field. Elsewhere the swipe stays above a visible keyboard.
* **Where it swipes.** Inside the scroll container (`container` = `{ ref, type, id?, bounds }` of the scrollable
  element: the smallest one under `x,y` if given, else the largest that scrolls along that axis), over `distance` × its length, in the 8–92 % band of the
  screen, for `durationMs`. Without a container it uses the screen (centred on `x,y` if given).
* **Nothing to scroll.** If the tree says nothing on screen scrolls (Android's `scrollable` flags), it returns at
  once: `found: false, scrolls: 0, endReached: true, nothingToScroll: true, reason: 'nothing to scroll on this
  screen'`, with `summary`. iOS, OCR-only screens and webviews are never judged unscrollable this way.
* **Swipe.** On Android it is a drag that holds 200 ms before lifting, so lists don't fling past the target
  (`method: 'drag (hold before lift)'`; injected by the on-device helper, else an `input motionevent` sequence;
  before this release the value was `'motionevent drag (hold before lift)'`); elsewhere it is the backend's swipe. An element in
  the strip the content is arriving from gets one more scroll.
* **End of list.** With a tree, a swipe that leaves the container's content (its texts and their positions) the same
  ends it: `found: false, endReached: true, reason: 'end reached, not found'`. On iOS the rows are compared without
  the chrome that changes by itself (the status bar clock, scroll indicators, a search field floating at the bottom),
  and rows that moved back by less than 12 % of the container count as unmoved (the bounce at the end of a list).
  Screen pixels are compared only without a usable tree (OCR, empty containers): the `/wait idle` thumbnail diff,
  status bar and scroll indicators masked. Running out of `maxScrolls` gives `reason: 'not found within maxScrolls'`
  (`scrolls` says how many). When the tree never
  had the text, one OCR look at the last frame runs before giving up (`ocrTried`). Not found is a 200 with `found:
  false`, not an error.

**`/swipe`** (`direction` = the finger's movement: `up` reveals what is below) uses the same placement: Android hides
the keyboard first and swipes inside the scroll container (chosen as above); other platforms swipe in
the screen's content band (≤64 % of it, never from an edge, which would open Notification Center on iOS).

**`/gesture`**:
* Android: `go_home` = HOME key, `app_switcher` = APP_SWITCH key, `notification_center` = `cmd statusbar
  expand-notifications`, `control_center` = `cmd statusbar expand-settings` (Quick Settings).
* iOS: `go_home` = the home button. `app_switcher` = the backend's `app_switch` key (simulator: Home pressed twice
  in one HID session). A swipe up from the home indicator needs a pause before lifting, which `swipe` can't do, so
  backends without that key (physical iPhones today) return `501 not_supported`. `control_center` = a swipe down
  from the top-right corner; `notification_center` = a swipe down from the top left. Close them with `go_home`.
  The simulated Home button doesn't close these overlays, so on iOS `go_home` reads the tree first. If the switcher
  is up it taps below the cards. If Control Center or Notification Center is up (or `/gesture` opened one) it does a
  slow swipe up from the bottom edge and then presses Home.
* Aliases: `home`, `recents`, `app_switch`, `quick_settings`, `notifications`.

**`SystemPrompt`** (`src/core/types.ts`, detector in `src/core/prompts.ts`) = `{ kind, reason, buttons: { text, ref?,
bounds, role?: 'accept'|'dismiss' }[], needsHuman, title?, message?, source? }`. `kind` is one of:
* `permission`: iOS "Allow … to …?" / Android runtime permission dialogs.
* `alert`: a generic dialog with 1–3 buttons.
* Needs a human: `passcode`, `biometric` (Face ID / Touch ID / fingerprint), `allow_paste`, `install_profile`
  (profile / certificate / device admin), `credentials` (Apple Account / App Store / Google password sheets).

`/alert` taps a button by its centre and never types:
* `accept` picks the persistent grant ("Allow While Using App", "While using the app", "Allow", "OK").
* `dismiss` picks "Don't Allow" / "Deny" / "Cancel".
* `button=<label>` matches exactly, else the shortest label that contains it.

It refuses `needsHuman` kinds with `403 needs_human` (hand off with `/handoff` instead). Other errors:
* `404 no_prompt`: nothing on screen. Hints carry a screen summary.
* `404 no_button`: no button with that label.
* `409 ambiguous_button`: e.g. `accept` on a "Delete / Cancel" alert. Hints list the buttons.

`dismissed` is true once the same prompt is gone after `settleMs` (it checks once more 800 ms later).

## Apps & system
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | /v1/devices/:id/apps | `?system=1` | `AppInfo[]`, without system apps unless `system=1` (all backends, iOS simulator included). Android fills `name` with the app's label (see *Android notes*); it is absent until known |
| POST | /v1/devices/:id/apps | `{ path }` (local .apk/.app/.ipa/.zip path on the Mac) or `{ url }` (daemon downloads it first) | `{ ok, app? }` |
| DELETE | /v1/devices/:id/apps/:appId | – | `{ ok }` |
| POST | /v1/devices/:id/apps/:appId/launch | `{ verify?: true, expect? }` | `{ ok, inFront?, foreground?, relaunched?, delivery, retrySafe, expect? }` (added; `expect` is checked after the in-front check): after launching, polls the foreground app for up to 3 s. `inFront` = the app is in front, `foreground` = the app id that is (`null` = home screen). On iOS, when the home screen is still up after 1 s (a launch right after Home), it launches once more: `relaunched: true`. All three are absent when the backend can't read the foreground app or `verify: false` |
| POST | /v1/devices/:id/apps/:appId/terminate | – | `{ ok }` |
| POST | /v1/devices/:id/open-url | `{ url }` | `{ ok }` |
| POST | /v1/devices/:id/shell | `{ command }` | `ExecResult` |
| POST | /v1/devices/:id/files/push | `{ local, remote }` | `{ ok }` |
| POST | /v1/devices/:id/files/pull | `{ remote, local }` | `{ ok }` |
| GET | /v1/devices/:id/logs | `?lines=300&filter=&app=` (`app`: a package or bundle id; only that app's lines) | `text/plain` |
| POST | /v1/devices/:id/location | `{ lat, lon }` | `{ ok }` |
| POST | /v1/devices/:id/push | `{ appId, payload }` | `{ ok }` |
| POST | /v1/devices/:id/rotate | `{ orientation: 'portrait'\|'landscape' }` | `{ ok, orientation, screen?, note? }` once the screen has turned (see *Rotation*). `orientation` is what the screen shows afterwards; `note` is set when it stayed put |
| GET | /v1/devices/:id/foreground | – | `{ app: AppInfo \| null }` |
| GET | /v1/devices/:id/clipboard | – | `{ text: string \| null }` (added): the clipboard's plain text, `null` when it is empty or holds no text. Needs no lease (see *Clipboard*) |
| PUT | /v1/devices/:id/clipboard | `{ text }` (a string, `""` empties it; at most 100,000 characters) | `{ ok, length }` (added; `POST` also accepted): replaces the clipboard. Needs the lease like other input |
| GET | /v1/devices/:id/crashes | `?since=<ISO>&appId=&limit=20` | `CrashReport[]` (newest first) |
| GET | /v1/devices/:id/crashes/:cid | `?full=1&maxChars=16000` | `{ id, text, truncated, length }`. By default: header + crashed thread (Apple `.ips` JSON is summarised) |
| POST | /v1/devices/:id/recording/start | `{ maxSeconds?: 300 }` (1–3600) | `{ ok, active, path, startedAt, maxSeconds }` → `<state>/recordings/<name>-<time>.mp4`; `409 recording_active` |
| POST | /v1/devices/:id/recording/stop | – | `{ ok, path, sizeBytes, durationSec, warning? }` (`durationSec` = length of the video file, read with ffprobe; the time between start and stop only if the file can't be read); `409 not_recording`. It also auto-stops at `maxSeconds` and on shutdown or delete |
| GET | /v1/devices/:id/recording | – | `{ active, path?, startedAt?, maxSeconds?, owner? }` |
| GET | /v1/devices/:id/apps/:appId/data | – | `[{ name, path, savedAt, sizeBytes, files }]` saved snapshots, newest first |
| POST | /v1/devices/:id/apps/:appId/data/export | `{ name }` | `{ ok, appId, name, path, sizeBytes, files }`: snapshot of the app's data container → `<state>/appdata/<device>/<appId>/<name>` (overwrites) |
| POST | /v1/devices/:id/apps/:appId/data/import | `{ name }` | `{ ok, appId, name, path }`: restores a snapshot (`404` if unknown) |

`foreground`, `clipboard`, `crashes`, `recording/*`, `apps/:appId/data/*`, `keyboard/hide`, `rotate`, `files/*` and `push` return
`501 not_supported` on backends that lack them (see `capabilities` in `/v1/backends`). Names are `[A-Za-z0-9._-]`.

**Rotation.** Devices that can turn list `rotate` in their capabilities; the app hides Rotate for the rest. `rotate`
turns the screen and returns once it has turned (or after ~1.5–2 s if the app on screen keeps its orientation).
* The response says how the screen ended up. Phone home screens are portrait-only (the Pixel launcher, the iPhone
  home screen and Settings), so asking for landscape there gives `orientation: 'portrait'` with a `note`; the
  rotation is kept and the screen turns once an app that can rotate is open. `screen` is the new size: coordinates
  from earlier screenshots are no longer valid. Live streams restart at the new size (≈0.3 s); the `/ui` cache is
  dropped.
* Android: `cmd window user-rotation lock <n>` (Android 12+; older releases fall back to `set-user-rotation` and the
  `user_rotation` setting). The rotation stays locked until the next rotate. Landscape is a quarter turn
  counter-clockwise (the camera on the left); on a tablet whose natural orientation is landscape, portrait is the turn.
  * One source of truth: the display's real rotation and size, read from the window manager (`dumpsys window
    displays`: `mRotation`, `cur=WxH`; the input viewports of the active display as a fallback). `rotate`'s answer,
    `Device.screen`/`orientation`, screenshots, `/ui` (`tree.screen`; the hierarchy is re-read if it was dumped in the
    other rotation) and the tap transform all use it. `rotate` returns once that rotation has settled: no app is in
    the middle of a fixed-rotation launch (`mFixedRotationLaunchingApp`) and two reads agree. It says "stays in
    portrait" at once when the app in front asks for a fixed orientation (`mCurrentAppOrientation`), e.g. the launcher.
  * `launchApp` keeps a rotation lock: the monkey launch Android uses frees it, so it is put back right after.
* iOS simulator: `xcrun devicectl device orientation set` (an Xcode without it leaves `rotate` out of the
  simulators' capabilities). Landscape is `landscapeLeft` (the Dynamic Island on the left). Errors:
  `409 rotation_locked` (the simulator's orientation lock is on), `500 rotate_failed`.
* On Android an app can also turn the screen itself (one that only runs in landscape); `Device.screen`,
  `Device.orientation` and the live stream follow it.
* Activity log: `rotate` `{ orientation, stayed? }` (`stayed` = the orientation the screen kept).
* Backends report the screen with each stream frame (`FrameStream.onFrame(cb(jpeg, screen?))`) and may offer
  `FrameStream.restart()`, which the daemon calls after a rotation; streams without it are stopped and reopened.
  The same goes for live video: `Backend.video?(nativeId, { maxSize })` returns a `VideoStream` whose `onPacket`
  delivers `VideoPacket`s (`screen`, `config`, `frame`, `state`, `reset`; `src/core/types.ts`), with optional
  `restart()` and `requestKeyFrame()`.

**Clipboard.** Devices that can read and set it list `clipboard` in their capabilities: iOS simulators
(`simctl pbpaste` / `pbcopy`), Android emulators and phones (the helper, below), and iPhones on iOS 27 or later (the
CoreDevice pasteboard service, through the native sidecar). iPhones before iOS 27 return `501 not_supported`.
* Plain text only. A clipboard holding only an image reads as `null`; on an iPhone a copied link (Safari's "Copy Link")
  reads as its URL. Text goes in and out exactly: emoji, newlines and trailing whitespace are kept.
* Pasting is up to the app: long-press the field and tap Paste. On Android 13+ a set from PhoneDock doesn't show the
  system's "Copied" preview. On iOS, Paste from the edit menu just works; an app that reads the clipboard on its own
  may make iOS ask "Allow Paste".
* The text can be a secret (a one-time code). The daemon never logs it: the Activity log records
  `clipboard.set` `{ length }` only, and errors never quote it.
* Errors: `400 bad_request` (`text` missing, not a string, or too long), `502 clipboard_failed` (the device didn't
  answer; hints say what to try), `409 device_locked` (an iPhone that is locked: iOS returns no clipboard items
  then, so a read that finds no text on a locked phone says so instead of returning `null`).

**Android notes.** PhoneDock pushes a small helper (`/data/local/tmp/phonedock-helper-<hash>.dex`, run with
`app_process`, never installed as an app; source in `src/backends/android-helper.ts`) and uses it for:

- `/ui` (and `find`, `wait`, `tap --text`, `scroll-to`): one persistent UiAutomation connection per device produces
  the same XML as `uiautomator dump`, but waits only until the screen has been quiet for 500 ms instead of a fixed
  1 s plus start-up each time (≈40 ms per read on a still screen instead of ≈2 s). After 5 s without a quiet moment
  it reads the screen anyway. It closes after 20 s without a read. Android allows one UiAutomation connection at a
  time, so while it is open your own UiAutomator/Espresso tests cannot connect (and vice versa: PhoneDock then falls
  back to `uiautomator dump`).
- `GET /apps`: labels (`AppInfo.name`) are read on the device in the background, cached per package and
  `versionCode`, and also taken from the APK at install. A list waits at most 250 ms for labels it does not have
  yet; the rest appear in the next list. If labels cannot be read, `name` is left out; the list never fails because
  of it.
- `/clipboard`: reads and sets the primary clip as the shell user (≈1 s each, the helper's start-up), which Android
  allows in the background. A set falls back to `cmd clipboard` where the phone has it.

`PHONEDOCK_ANDROID_HELPER=0` (daemon environment) turns the helper off: `/ui` uses `uiautomator dump`, apps
have no `name` unless it came from an install, and reading the clipboard returns `501 not_supported`.

## Human handoff
An agent hits something it must not or cannot do itself: Face ID, a passcode, a CAPTCHA, an Apple Account
sign-in, a payment. It asks a human, and the Mac app shows the request.

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | /v1/devices/:id/handoff | `{ reason, timeoutSec?: 900 }` (10 s – 24 h) | `Handoff`; `409 handoff_pending` if the device already has one (hints name it) |
| GET | /v1/handoffs | `?state=pending\|done\|cancelled\|timeout&deviceId=` | `Handoff[]` |
| GET | /v1/handoffs/:hid | `?waitSec=0` (≤60: long-poll while pending) | `Handoff` |
| POST | /v1/handoffs/:hid/resolve | `{ state: 'done'\|'cancelled', note? }` | `Handoff`; `409 handoff_resolved` if not pending |

`Handoff` = `{ id, deviceId, reason, requestedBy, createdAt, expiresAt, state: 'pending'|'done'|'cancelled'|'timeout',
note?, resolvedAt?, resolvedBy?, leaseHolder?, returnLease?, leaseReturned? }`.
* `requestedBy` and `resolvedBy` are `X-PhoneDock-Owner` values; the app resolves as `app:human`.
* An expired handoff becomes `timeout` with `resolvedBy: 'daemon'`.
* **The device stays the requester's.** While a handoff is pending, `app:human` may act on the device without taking
  the lease (other owners still get `lease_conflict`). The requester's lease doesn't expire while it waits, and
  its TTL restarts when the handoff ends.
* **Take Over and the lease.** The app's Take Over is an `app:human` lease with `force`. When the handoff is resolved
  `done` or `cancelled` while `app:human` holds the lease, the lease goes back to the requester, with its own TTL,
  if the requester held it when it asked (`returnLease: true`), hasn't released it since and is still running.
  Then `leaseReturned: true` is set. A timeout returns nothing: the person keeps the device until they hand it back.
  `leaseHolder` is who holds the lease when the handoff was created and, after it ends, who holds it then.
  A later `DELETE /lease` from `app:human` (the app's Hand Back) is a no-op then.
* **Activity log:** `handoff.requested` `{ handoffId, reason, timeoutSec }` (as the requester), `handoff.done`
  `{ handoffId, note? }` and `handoff.cancelled` `{ handoffId, reason? }` (as the resolver; the app's Done and Can't
  Do It), `handoff.timeout` (as `daemon`), `lease.returned` `{ to, from, handoffId }` (as `daemon`).
* Every change emits SSE `handoff` and refreshes `Device.handoff`.
* Handoffs are kept in memory, so a daemon restart forgets them.

## Physical device connection
| Method | Path | Body | Response |
|---|---|---|---|
| POST | /v1/connect | Android over Wi-Fi: `{ address? , serial?, restartAdb? }`. `address` = `host:port`. With no address it connects to the discovered phone named by `serial`, or the only phone that has Wireless debugging on (`404 no_connect_service`, `409 ambiguous_phone`). Waits until the phone is online | `{ ok, device?, message? }` |
| POST | /v1/connect | `{ platform: 'ios', wdaUrl \| address, name?, udid? }` – iPhone over Wi-Fi via WebDriverAgent. `address` = IP/host → `http://<address>:8100`. Verifies `GET <wda>/status`, saves it to `ios-device.json` in the state dir | `{ ok, device?, wdaUrl }` (`502 wda_unreachable` if WDA doesn't answer) |
| DELETE | /v1/connect/:id | – | `{ ok }` forget a saved iOS Wi-Fi/WDA connection (`404` if none) |
| POST | /v1/pair | `{ address, code, restartAdb? }` (Android 11+ wireless debugging pairing, pairs only) | `{ ok, message }` |
| POST | /v1/pair | `{ code, serial?, restartAdb? }` – **no address**: pairs with the phone that is showing "Pair device with pairing code" (found by discovery), then connects to its Wireless debugging service (same serial, or same IP) and waits until it is online. `serial` picks one when several phones show a pairing screen. Errors: `404 no_pairing_service` ("Open Wireless debugging › Pair device with pairing code on the phone and keep it open"), `409 ambiguous_phone` (lists the phones; retry with `serial`), `502 pair_failed`, `504 connect_pending` | `{ ok, device?, message, serial? }` (`serial` = the phone that was paired) |
| GET | /v1/android/discover | – | `[{ serial, model?, host?, ip?, connectPort?, pairingPort?, connected, connectInstance?, pairingInstance? }]` – about 3 s Bonjour browse of `_adb-tls-connect._tcp` (Wireless debugging is on → `connectPort`) and `_adb-tls-pairing._tcp` (the pairing screen is open → `pairingPort`), joined by serial. `connected`: already online in `adb devices`. Nothing is paired or connected |

**Local Network errors (Android Wi-Fi).** When adb answers "No route to host" for a private address, the daemon probes the phone with its own TCP connection (3 s). Both `/v1/connect` and `/v1/pair` then fail with one of:
- `502 adb_blocked_local_network`: the daemon can reach the phone, so the shared adb server was started by an app macOS doesn't let onto the network. Retry with `restartAdb: true` (CLI `--restart-adb`): the daemon runs `adb kill-server` and `adb start-server`, then tries once more. This briefly disconnects other adb users, such as Android Studio. adb is never restarted without that flag.
- `502 local_network_denied`: the daemon can't reach it either. PhoneDock (or, when the daemon runs from a terminal, that terminal app) lacks permission: System Settings › Privacy & Security › Local Network.

| GET | /v1/ios/discover | – | `[{ name, host?, udid?, mac?, source: 'bonjour'\|'devicectl', service?, deviceId?, transport? }]` – ~3 s Bonjour browse (`_apple-mobdev2._tcp`, `_remotepairing._tcp`) + devicectl network-paired devices. Discovery only; nothing is connected |
| POST | /v1/ios/wda-setup | `{ udid, team?, destination?, name? }` | `202 { job }` – shallow-clones appium/WebDriverAgent into `<state>/wda`, runs `xcodebuild … -scheme WebDriverAgentRunner -destination id=<udid> [DEVELOPMENT_TEAM=<team>] test`; the job is `done` when the log prints `ServerURLHere->http://<ip>:8100<-ServerURLHere` (that URL is saved for the device; xcodebuild keeps running to host WDA). `destination` overrides the xcodebuild destination (e.g. `platform=iOS Simulator,id=<udid>`) |

**ios-device Wi-Fi devices:** `connection: 'wifi'` for devicectl devices with `transportType: 'localNetwork'` and for manual WDA
entries. Manual entries without a known udid have `nativeId = wda-<host>-<port>` and capabilities limited to what WDA
can do (no install/apps list); `state` is `running` when `GET /status` answers, else `offline`. `meta.wdaUrl`, `meta.wdaReady`.

**ios-device live video (iOS 27+).** These devices list `video`: `GET /video` serves the phone's own HEVC stream as it
arrives (not re-encoded; up to 60 fps while the screen moves, measured ~58 frames/s scrolling Settings over Wi-Fi), with
`codedWidth`/`codedHeight` in `screen` for the padding. Under heavy motion the phone can draw a shrunk copy of the screen
in the top-left corner of the picture, flat grey (R = G = B = 128) around it, for a few frames; the Mac app stretches it
back. A viewer that joins while another app streams the phone gets `{ state: 'error', code: 'stream_busy' }` and should
poll `/frame`. They also list the `stream` capability: `/frame` and `/stream` decode the phone's
own screen stream (RTP/HEVC, the one input already holds; VideoToolbox → JPEG, at most `fps`, only changed frames),
about 10–15 fps with ~20 ms added on the Mac. A viewer never takes the stream from Xcode Device Hub or iPhone Mirroring:
while another client streams the phone (or the stream can't open) frames come from screenshots, and video is tried
again after 10 s, doubling up to 60 s. The stream closes about 5 s after the last viewer (45 s after the last input,
if later). `POST /recording/start` writes the same stream to the `.mp4` without re-encoding (HEVC `hvc1`, up to 60 fps);
on older iOS, or when the stream is busy, it uses `devicectl` screen-record or screenshots as before. `GET /info` adds
`liveVideo: { frames, feed }`. `frames` (the latest frame stream; `null` before the first viewer) = `{ mode:
starting|video|screenshots|stopped, reason?, frames, fps, latencyMs?, collapsed, startedAt, firstFrameMs? }`; `feed`
(`null` while nothing uses the stream) = `{ consumers, units, bytes, lastUnitAgoMs, config?: { codec, codecString,
codedWidth, codedHeight, width, height } }`.

## Pools / orchestration
| Method | Path | Body | Response |
|---|---|---|---|
| POST | /v1/pool/acquire | `{ owner, platform?, backend?, createIfNone?: DeviceSpec, ttlSec? }` | `{ device, lease }` – picks a running device that is unleased (or whose lease is stale); boots a stopped one; or creates one. The lease follows the rules in *Leases* (default 10 min sliding TTL) |
| POST | /v1/pool/release | `{ owner, deviceId }` | `{ ok, released, heldBy?, note? }` (as `DELETE /lease`) |

## Flows

A flow is a regression test as a small YAML (or JSON) file: what an agent did once, replayable on every PR.
`flow save` builds one from the action log; `phonedock test` (or the MCP `run_flow` tool, or `runFlowFiles()` in the
TS SDK) runs it and exits non-zero on failure. Code: `src/core/flow.ts` (format, conversion, Maestro export),
`src/core/flow-runner.ts` (runner, JUnit), `src/daemon/routes-flow.ts`, `src/daemon/observe.ts`. CI: `docs/CI.md`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /v1/devices/:id/flow | `{ since?, until?, owner?, name?, appId?, assertions?, autoAssert?: true, keepNoise?: false, format?: 'yaml' \| 'json' }` | `{ text, format, flow, warnings[], dropped[], stats: { entries, observations, steps, assertions }, range: { since, until, owner } }` – the flow file's text; the caller writes it |

* **Range.** `since` / `until`: ISO time or a duration back from now (`"10m"`, `"2h"`). Default: the latest session,
  meaning everything after the last 15-minute pause, or after the last `lease.acquire` (by `owner`, if given) when that
  is later. `owner` limits actions to one owner (`"mcp:*"`: a prefix); screens read after another owner's next action
  are not used. Owner `daemon` is always left out.
* **What it reads.** `actions.jsonl` plus `observations.jsonl` (same folder): the daemon notes the visible texts and a
  signature of the screen whenever it reads a fresh UI tree (`/ui`, `/find`, `/wait`, `/fill`, …) and the screen changed
  or an action happened since, and every finished `/wait` and `/scroll-to`. That file is internal (2 MB, then rotated).
  Reads are not actions, so they never show up in the activity log.
* **Conversion.** `/fill` is one `fill` step (its first tap carries `fill: { text|id|type, value | length (secret),
  submit, clear }` in the log); taps with a `selector` or a `label` become text selectors, ref taps use the element's
  text or id, other taps become fragile percent points; tap field + clear + type becomes `fill`; `scroll-to` swipes
  become one `scroll_to`; successful waits become `wait_for` (unless the next step uses the same element). Left out,
  and listed in the file header: timed-out waits, `scroll-to`s that found nothing, a fill repeated on the same field
  (the last one is kept), a tap undone by `back` or by tapping again when the screen ended as before (`keepNoise`
  keeps them), shell / install / location / snapshot / app-data actions, pinches, lease and handoff events. Typed
  secrets become `${SECRET_n}` with a warning.
* **Assertions.** `assertions`: texts that must be visible at the end (`"!text"`: must not be), or steps such as
  `{ "assert_text": { "field": "id:status", "equals": "On" } }`; they replace the automatic final check. With
  `autoAssert` (default), the flow gets `assert_visible` for a distinctive text of the first screen after each launch
  (new compared with the screen before; no digits, ≤ 40 characters, not OK/Cancel/Back) and of the final screen. Before
  saving without `until`, the daemon reads the screen once more so the final screen is known.

### Flow file format

```yaml
name: Greet Ada and turn on notifications
appId: dev.phonedock.sample        # used by launch/terminate without an app, and for app logs on failure
platform: android                  # android | ios: the flow is skipped on other platforms
minOS: "16"                        # skipped on older OS versions (flow save writes the recorded version)
env: { USER_NAME: Ada }            # defaults for ${VAR}; the process environment and --env win
steps:
  - launch: dev.phonedock.sample   # stops the app first; { app: …, stop: false } keeps it running
  - assert_visible: PhoneDock Sample
  - fill: { field: Your name, value: "${USER_NAME}" }
  - tap: Greet
  - wait_for: { visible: "Hello, Ada!" }
  - tap: { text: Notifications, type: Switch }
  - assert_text: { field: id:notifyStatus, equals: Notifications on }
```

A top-level list of steps is a flow too. Each step is one command, optionally with modifiers `optional: true` (a
failure only warns), `timeout: <ms>` (element waits and assertions; default 10 s, iOS 15 s), `label: <text>` (shown
instead of the generated description).

**Selectors** (`tap`, `long_press`, `double_tap`, `fill.field`, `scroll_to`, `wait_for`, `assert_*`): plain text
(`tap: Sign in`, case-insensitive contains over text, label, value and placeholder, exact matches first, like `/find`),
`id:login_button`, or `{ text?, id?, type?, match?: contains|exact|regex, index? }`. Raw points `{ at: "50%,62%" }`
(percent of the screen) or `{ at: [540, 1210] }` (device pixels) work but are marked `fragile`; `flow save` writes a
comment above them.

| Command | Argument |
|---|---|
| `launch` / `terminate` | app id (or nothing: the flow's `appId`) |
| `tap`, `long_press`, `double_tap` | selector, or `{ at: point }`; `long_press` takes `duration` |
| `fill` | `{ field: selector \| at: point, value, submit?, clear?: true, secret? }` |
| `type` | text, or `{ text, submit?, secret? }` |
| `key` | key name (`enter`, `delete`, `tab`, `back`, `home`, …) |
| `back`, `home`, `hide_keyboard` | – (bare words) |
| `scroll_to` | selector, or `{ text \| id, direction?: down, max? }` |
| `swipe` | `up` / `down` / `left` / `right` (the finger's direction), `{ direction, distance?, duration? }` or `{ from, to }` (fragile) |
| `wait_for` | `idle`, `{ visible: selector }`, `{ gone: selector }`, `{ idle: <stable ms> }` |
| `set_appearance` / `rotate` / `open_url` / `gesture` | `dark`\|`light` / `portrait`\|`landscape` / URL / `go_home`\|`app_switcher`\|`control_center`\|`notification_center` |
| `alert` | `accept`, `dismiss` or `{ button: Allow }` (system prompts) |
| `sleep` | milliseconds (prefer `wait_for`) |
| `assert_visible` / `assert_not_visible` | selector |
| `assert_text` | `{ field: selector, equals \| contains \| matches: … }` (the element's value, else its text) |
| `screenshot` | name, or `{ name, baseline?: path, tolerance?: 0.02 }`: saved in the artifacts folder; with a baseline (relative to the flow file; created when missing), fails when more than `tolerance` of a 64-px-wide grayscale thumbnail differs |

### Running

`phonedock test <files|dirs…> [--device ID] [--platform android|ios] [--junit out.xml] [--artifacts DIR] [--retries N] [--timeout MS] [--env NAME=VALUE]…`

* Folders are searched for `*.yaml`, `*.yml`, `*.json` (not `*.maestro.yaml`), in name order. A file that doesn't
  parse fails. Without `--device`: `$PHONEDOCK_DEVICE`, else the only running device.
* The runner leases the device for the run (and releases it if it took it). Every element step waits for its element
  to be visible, re-settles if it only just appeared, and acts on the match's centre; after each action it waits up to
  3 s for the screen to stay still for 400 ms (`launch`, `open_url`: longer). It prints `PASS`/`FAIL`/`WARN` per step
  with timings. A failure names the step, what was expected and what was on screen (`Screen now: …`, the same summary
  as `wait_timeout`), skips the rest, and saves `failure.png`, `ui.txt`, `ui.json`, `logs.txt`, `app.log` (the flow's
  app), `steps.txt` and `result.json` into `<artifacts>/<flow name>[-attemptN]/` (default
  `$PHONEDOCK_HOME/test-runs/<time>/`).
* `--retries N` runs a failed flow again (whole flow). Exit code 0 only when every flow that ran passed and at least
  one ran; 1 otherwise; 2 for usage errors. `--junit` writes one `<testcase>` per flow (steps in `<system-out>`).
* `phonedock flow save <id> [-o file] [--since 10m] [--owner O] [--name N] [--app ID] [--assert TEXT]… [--no-assert] [--keep-noise]`
  wraps `POST /flow` (no `-o`: the YAML goes to stdout). `phonedock flow check <files|dirs>` validates and lists steps.
  `phonedock flow export --maestro <file> [-o out.yaml]` writes Maestro YAML: equivalent commands are mapped
  (`tapOn`, `inputText`, `scrollUntilVisible`, `extendedWaitUntil`, `assertVisible`, …), texts become escaped regexes,
  and steps without an equivalent (`set_appearance`, `sleep`, `alert accept`, system gestures) are commented out with
  the reason. The mapping has not been run with Maestro here.

## Performance traces

Measure one app while a flow runs, then change the code and measure the same flow again. The loop:
`trace/start` → drive the flow (taps, `batch`, a flow file) → `trace/stop` → read the summary → change the code,
rebuild, reinstall → `trace/start` again with the same app and template → `trace/stop` shows each metric
before → after. This is not a profiler UI; the summary points to the files for deeper digging.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /v1/devices/:id/trace/start | `{ appId, template?, timeLimitSec?: 60, launch?: false }` | `{ ok, active, traceId, appId, tool, template, instruments, process: { pid?, name? } \| null, launched, startedAt, timeLimitSec, dir }` once recording has begun. `409 trace_active` when the device already has one |
| POST | /v1/devices/:id/trace/stop | `{ compareTo?: traceId \| "none", top?: 5, triageChars?: 1200 }` | `{ ok, traceId, text, summary }` (below). `409 not_tracing`; `404 not_found` for an unknown `compareTo` (checked before the trace is stopped) |
| GET | /v1/devices/:id/trace | – | `{ active, traceId?, appId?, template?, startedAt?, timeLimitSec?, owner?, ready?, dir?, finished? }`; `finished: { traceId, appId, endedAt, reason }` = a trace the time limit ended that no stop has collected yet |
| GET | /v1/devices/:id/traces?limit=20 | – | Earlier traces, newest first (max 200): `[{ traceId, appId, template, startedAt, metrics, files }]` |

* **One trace per device.** Start needs the device lease (like input), a running device and the app's id (bundle
  id or package). The app must be running unless `launch: true`. Stop needs no lease.
* **Time limit:** `timeLimitSec` defaults to 60 and is clamped to 2–600 (missing or invalid values mean 60). The
  recorder stops itself at the limit; the daemon collects the result a few seconds later, and the next `trace/stop`
  returns it with `stopReason: "time limit (N s) reached"`. A trace also stops when the device is shut down or
  deleted. When the daemon exits, it stops every recorder without a summary. xctrace gets SIGINT, finishes writing
  the `.trace` (it writes to its own log, so it doesn't depend on the daemon) and exits by itself; the daemon waits up
  to 20 s. perfetto is stopped and its file is removed from the device. On the next start, the daemon stops any
  `xctrace` that a crashed daemon left recording.
* **iOS (simulator and iPhone):** `xctrace record --attach <pid>` with template `"Time Profiler"` by default.
  Any template from `xcrun xctrace list templates` or a `.tracetemplate` path works. If the template lacks Hangs
  or Time Profiler, they are added with `--instrument`, and `instruments` lists what was added. Stop sends SIGINT,
  waits for xctrace to finish the file, checks that it opens (`xctrace toc`), and reads it with
  `xctrace triage --style hangs` and `xctrace show` (the Hangs table and the main thread's inverted call tree).
  On an iPhone the app must be a development build (`app_not_debuggable` otherwise), and Developer Mode must be on.
* **Android (emulator and phone):** `perfetto` on the device (sched, CPU frequency, SurfaceFlinger frame timeline,
  atrace gfx/view/input/am/wm/dalvik/binder for the app). The trace is written under `/data/misc/perfetto-traces`,
  then pulled to the Mac and removed from the device. Also `dumpsys gfxinfo <package>`: reset at start, read at
  stop. The frame stats come from gfxinfo. Open `trace.perfetto-trace` in https://ui.perfetto.dev. PhoneDock
  installs nothing. If `trace_processor_shell` is on the PATH, a note names it for SQL queries.
* **Files:** `<state>/traces/<device>/<traceId>/`: `trace.trace` or `trace.perfetto-trace`, `summary.json` /
  `summary.txt`. iOS also has `triage.md` (the full triage report), `toc.txt`, `xctrace.log` and `command.txt`
  (the exact xctrace command). Android also has `gfxinfo.txt` and `perfetto-config.pbtxt`. Trace files are big
  (Time Profiler is about 10–20 MB for 10 s on a simulator; App Launch about 200 MB). Only the newest 10 traces per
  device keep theirs; older ones keep `summary.json`, `summary.txt` and `triage.md`, and are still listed and compared.
* **Activity log:** `trace.start` `{ appId, template, timeLimitSec }`, `trace.stop`
  `{ appId, template, durationSec, summary, reason? }`, `trace.start_failed` / `trace.stop_failed` `{ appId, error }`.
  SSE `event: trace`: the start response plus `deviceId` on start; `{ deviceId, active: false, traceId, metrics, reason }`
  on stop.
* **Errors (with hints):** `trace_active` 409, `not_tracing` 409, `device_not_running` 409, `app_not_installed` 404,
  `app_not_running` 409, `app_not_debuggable` 409 (iPhone: not a development build), `attach_failed` 409,
  `developer_mode_off` 409, `device_unavailable` 409, `bad_template` 400, `xctrace_missing` 501 (set
  `DEVELOPER_DIR` to Xcode), `perfetto_missing` 501 (Android 9 and older), `trace_timeout` 504,
  `trace_failed` 500, `trace_invalid` 500 (saved but does not open).

**Summary** (`summary.json`, and `summary` in the stop response). The keys are the same on every run and platform;
what a platform doesn't measure is `null` / `[]`. With the default `top` / `triageChars`, the JSON stays under
3.5 KB: hot spots shrink first (down to 3 each), then the triage excerpt.

```jsonc
{
  "v": 1, "traceId": "2026-11-04T14-25-14-608-f313", "deviceId": "ios-sim:…", "device": "pdtest-perf-ios",
  "platform": "ios", "appId": "dev.phonedock.perfdemo", "tool": "xctrace", "template": "Time Profiler",
  "startedAt": "…", "endedAt": "…", "timeLimitSec": 60, "stopReason": null,
  "metrics": {                       // flat numbers or null: diff these between runs
    "durationSec": 15.6, "hangs": 1, "hangsTotalMs": 846, "hangsLongestMs": 846, "mainThreadMs": 1340,
    "topHotspotMs": 824, "topAppHotspotMs": 829, "frames": null, "jankyFrames": null, "jankyPct": null,
    "frameP50Ms": null, "frameP90Ms": null, "frameP95Ms": null, "frameP99Ms": null },
  "hangs": { "count": 1, "totalMs": 846, "longestMs": 846,
             "byType": { "severe": 0, "hang": 1, "microhang": 0, "brief": 0, "delay": 0 } },  // >2 s, >500 ms, >250 ms, >100 ms, >33 ms
  "hotspots": [ { "symbol": "countPrimesSlowly(upTo:)", "library": "PerfDemo", "ms": 824, "pct": 61.5 } ],  // main thread, self time
  "appHotspots": [ … ],              // main thread, the app's own functions (system calls they make charged to them)
  "frames": null,                    // Android: { total, janky, jankyPct, p50Ms, p90Ms, p95Ms, p99Ms, missedVsync, slowUiThread, deadlineMissed, jankyLegacyPct }
  "triage": "==============Hang #1==============\n…",   // capped excerpt of `xctrace triage --style hangs`; full report in triage.md
  "compare": { "traceId": "…", "startedAt": "…",       // the previous trace of the same app + template on this device
               "changes": { "hangs": { "before": 1, "after": 0, "delta": -1 }, … } },
  "files": { "dir": "…", "trace": "…/trace.trace", "triage": "…/triage.md", "summary": "…/summary.json" },
  "notes": [ … ]
}
```

`text` is the same summary as short lines: headline; hangs; main thread; hot spots; frames;
`vs <traceId>: hangs 1 → 0 (-1) · …`; `Metrics: {…}` (one JSON line); the triage excerpt; notes; file paths.
CLI: `phonedock trace start|stop|status|ls|run` (`trace run <id> --app X --flow f.yaml` = start, run the flow,
stop). MCP: `start_trace`, `stop_trace`.

## Performance metrics

`GET /v1/metrics` requires the daemon bearer token. It returns route and backend-operation timing in milliseconds, with lifetime `count` and `max`, and `p50`/`p95` computed from the most recent 1,024 samples per key. Routes are identified by method and route template; backend operations by backend ID and method. Long-lived stream routes measure handler setup rather than stream lifetime. Frame, screenshot, and input responses include a `Server-Timing: route;dur=...` header when headers have not already been sent.
