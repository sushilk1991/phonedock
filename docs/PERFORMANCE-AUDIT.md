# Performance audit

Measured on 2026-11-23 against PhoneDock 0.4.0 (`bf19b9e`), on branch `perf-audit`.
Two changes earned their place: faster source CLI startup and removal of a redundant discovery scan.
The Mac app, daemon, CLI and MCP were exercised with an isolated iOS simulator. Android and physical iPhone findings are source analysis, not hardware measurements.

## Method and environment

- Apple Silicon MacBook, 36 GiB RAM; exact OS/chip are in [environment.json](performance/2026-11-23/environment.json). Node 24.11.0 locally; Node 24.22.3 for focused Linux checks on the retained Instabox `fe-hero`.
- 38 available Xcode simulators, including one newly created `pdtest-perf-ios`, iPhone 17 Pro / iOS 26.5 (23F77), 1206 × 2622. The backend enumerated the full inventory; the `pdtest-` filter exposed only the test phone.
- Private source daemon on **47433**, scratch `PHONEDOCK_HOME`, `PHONEDOCK_DEVICE_FILTER=pdtest-`. The daemon on 47420, existing devices, Android runtimes and the Mac mini were left alone.
- Release Mac binary in a copied, ad-hoc signed 0.4.0 bundle. Background `open -g -n -F`; 1280 × 840 window, inspector open, selected simulator, JPEG live view at `maxSize=900`. Opt-in SelfTest counters were present in both measured app builds.
- Same Node executable, simulator, filtering, app steps and measurement harness before/after. No builds overlapped the controlled measurements. This is a busy shared Mac: memory pressure and swap varied considerably. Sequential whole-system results are observations, **not causal speedup claims**. The CLI comparison alternated before/after order; discovery was also measured with a deterministic backend call counter.
- HTTP device listing: 50 calls, then 50 fresh iOS-backend calls. Screenshots: 10 each, raw HTTP and MCP. MCP kept its normal prompt/UI checks. Idle daemon: 20 s. `/frame`: 30 s at a 75 ms target interval, including 304 responses. Separate multipart `/stream`: 30 s, request 15 fps. Frame age is daemon arrival-to-response age, not camera-to-display latency.
- App: time from issuing `open` to first nonempty device application; ten explicit refreshes plus automatic polling; 300 s live view; 6.5 s after stopping frames, then 30 s idle. CPU is process CPU time / wall time (100% = one core), excluding the first 10 s of each phase. App/daemon CPU excludes simulator, WindowServer and AXe capture processes. RSS sampled once per second; RSS alone cannot diagnose a leak under compression/swap.
- Main-thread profile: `/usr/bin/sample <pid> 5 10`. A five-second sample can identify a hotspot in that interval; it cannot certify a whole session free of hangs.
- An early pilot overlapped simulator boot/build and used a different Node version. It was discarded. The committed evidence contains the controlled runs; CLI times exclude the first warm-up pair, whose raw values are retained.

## Baseline and after

The daemon/stream observations below are sequential shared-host runs. Only the alternating CLI experiment and controlled provider-read count establish the retained fixes; no gain is attributed to the other changes in timing, CPU or RSS.

| Metric | Before | After |
|---|---:|---:|
| Source daemon health, single cold launch | 337.6 ms | 193.5 ms |
| Cached `GET /v1/devices`, n=50 | 1.82 / 16.53 ms | 0.80 / 4.48 ms |
| Fresh iOS backend listing, n=50 | 289.14 / 454.67 ms | 108.84 / 125.87 ms |
| Raw simulator PNG screenshot, n=10 | 858.65 / 1402.12 ms | 394.14 / 482.29 ms |
| Daemon idle CPU, 20 s | 0.05% | 0.00% |
| Daemon idle RSS, end | 51.5 MiB | 81.4 MiB |
| `/frame` HTTP poll cadence (includes 304) | 12.57 Hz | 13.17 Hz |
| `/frame` response latency | 1.20 / 7.30 ms | 0.58 / 0.73 ms |
| `/frame` new-image age, n=1 each | 1 ms | 0 ms |
| `/frame` daemon CPU / RSS | 0.96% / 82.6 MiB | 0.63% / 94.5 MiB |
| Multipart JPEG arrivals / distinct images | 11.75 fps / 2 | 13.80 fps / 1 |
| Multipart first frame, single start | 324.03 ms | 379.21 ms |
| Multipart inter-arrival gap | 71.63 / 138.90 ms | 69.46 / 102.91 ms |
| Multipart daemon CPU / RSS | 0.43% / 36.6 MiB | 0.43% / 92.2 MiB |

| Metric | Before | After |
|---|---:|---:|
| Launch to first nonempty device list | 2822.48 ms | 578.67 ms |
| Live CPU, process only | 2.07% | 2.37% |
| Selected, frames stopped: idle CPU | 0.94% | 1.56% |
| Five-minute live RSS, start → end | 176.7 MiB → 70.8 MiB (peak 176.7 MiB) | 188.2 MiB → 126.8 MiB (peak 188.3 MiB) |
| Main-thread Mach wait / sampled stacks | 371 / 381 | 451 / 451 |
| Explicit refresh batch: list applies / changed DTOs | 11 / 2 | 10 / 2 |
| Explicit refresh batch: root / sidebar / stage / screen / inspector bodies | 2 / 4 / 2 / 2 / 2 | 2 / 4 / 2 / 2 / 2 |
| Five-minute applies / changed DTOs | 26 / 15 | 29 / 21 |
| Five-minute root / sidebar / stage / screen / inspector bodies | 15 / 30 / 15 / 28 / 15 | 21 / 42 / 21 / 26 / 21 |

| Metric | Before | After |
|---|---:|---:|
| Source shell `devices`, alternating pairs, n=25 | 105.77 / 122.75 ms | 52.98 / 57.38 ms |
| Source CLI `devices` in sequential audit, n=20 | 261.02 / 343.40 ms | 45.48 / 52.10 ms |
| MCP initialize, single process start | 557.45 ms | 211.12 ms |
| Warm MCP `list_devices`, n=20 | 2.65 / 10.72 ms | 0.65 / 2.68 ms |
| MCP `screenshot`, default checks, n=10 | 1828.72 / 10944.41 ms | 873.15 / 992.99 ms |
| Provider reads for one changed inventory, controlled fake | 2 | 1 |

Evidence: [before daemon](performance/2026-11-23/baseline-daemon.json), [after daemon](performance/2026-11-23/after-daemon.json), [before app](performance/2026-11-23/baseline-app.json), [after app](performance/2026-11-23/after-app.json), [before stream](performance/2026-11-23/baseline-stream.json), [after stream](performance/2026-11-23/after-stream.json). Live windows ran for 300 s by SelfTest; external 1 Hz samples span 300.6 / 298.5 s. The after run had higher app CPU and resident memory; it is not an app CPU/memory improvement.


Timing columns use p50 / p95 unless stated otherwise. Counts and percentiles use nearest rank. The isolated device list has one visible device, so this does not establish large-sidebar scrolling performance.

## Findings, in order of demonstrated user impact

### 1. Source CLI startup spent time loading unrelated tools — fixed

`src/cli/main.ts` eagerly loaded flow parsing, visual comparison and report generation for ordinary commands.
A Node CPU profile showed module compilation, the TypeScript loader's WASM and loading code among the startup costs.
Deferring flow/trace imports reduced median `devices` latency from **193 to 177 ms** in 25 alternating pairs; p95 was **210 to 213 ms**, so this alone did not improve the tail.

The source shell launcher now enters through `bin/phonedock.mjs`, enables Node's compile cache before importing TypeScript, and dispatches `main` once, including the legacy `PHONEDOCK_CLI_MAIN=1` case. Help still imports the commands' own usage strings. No usage text or command checks were removed.

The combined source-launcher comparison, 25 alternating pairs against the same already-running daemon, measured **105.77 → 52.98 ms p50**, **122.75 → 57.38 ms p95** (50% / 53% lower). The first pair with an empty after-cache was **123.74 → 110.26 ms**; that single cold pair is not a cold-start distribution. The separate lazy-import and combined experiments occurred at different times and must not be compared across experiments.

This result applies to **`bin/phonedock` in a source installation on macOS**, not an npm script that directly runs `src/cli/main.ts`, and not a claimed 50% improvement to the prebundled CLI or Windows launcher. The daemon is already running; auto-start cost is excluded. Node documents the cache API, `NODE_COMPILE_CACHE`, and `NODE_DISABLE_COMPILE_CACHE` in its [module documentation](https://nodejs.org/docs/latest-v24.x/api/module.html#moduleenablecompilecachecachedir). Disabled and unwritable caches still run the command.

Evidence: [paired launcher samples](performance/2026-11-23/cli-source-launcher-paired.json), [lazy-import-only samples](performance/2026-11-23/cli-paired.json). Regression coverage exercises the actual shell launcher, help equality, cold/warm/disabled/unavailable caches, flow aliases, usage errors and unknown-command exit codes.

### 2. Publishing a changed inventory immediately forced another scan — fixed

`BackendInventory.onUpdate` invalidated the aggregate cache and scheduled `pollDevices()`. That function always asked for a fresh inventory, so finishing a changed scan immediately repeated backend discovery about 50 ms later. Backends can spawn `simctl`, `devicectl`, `adb` or perform provider I/O; this is avoidable work at startup and on inventory changes.

Completion now publishes through `pollDevices(false)`, which consumes the freshly completed inventory. Periodic polls, explicit invalidation and initial event subscriptions retain fresh discovery. Existing timeouts, stale/error fields, screen checks and crash/lease checks remain in place. No API field changed.

The regression failed before the fix with **2 backend reads for one changed inventory**, and passes after with **1**. After the fix, a second explicit poll inside the cache TTL still finds and publishes a renamed device, with **2 total reads across the two change cycles**. This is a 50% reduction in reads **for those completion-triggered cycles**, not a 50% reduction in all daemon polling or a claim that fresh-list latency fell by half. The 3 s regular polling cadence is unchanged.

Evidence: `src/daemon/discovery-poll.test.ts` also holds a provider past the initial bounded wait, releases it and asserts SSE publication without a second provider read; existing inventory tests cover bounded waits, late results, failure/recovery and invalidation fencing.

### 3. The measured Mac app did not have a per-poll invalidation storm

The baseline's 11 device-list applications changed the device DTO twice; root, stage, screen and inspector bodies evaluated twice, sidebar four times. `AppModel.applyDevices` already compares the sorted list before assigning it. The observable stale/refreshing metadata can genuinely change during discovery; deleting those fields to suppress updates would obscure state.

The sample had **371 of 381 main-thread samples in the event-loop Mach wait**, with seven in run-loop transaction work. It did not reproduce a main-thread hang. The JPEG decode is in a nonisolated async client method; its execution off the main actor is an inference from the Swift 5 concurrency model, not a separate instrumented guarantee. The app's FPS property has no view reader in the inspected code.

The `devicePoll` counter counts `applyDevices` calls from refreshes or SSE insertion, not HTTP requests. Body counters cover the named outer view bodies; they do not count every GeometryReader closure, child tab view, layout pass or GPU draw. These are bounded churn indicators, not total render counts. The external harness requires every expected counter snapshot and fails if any is missing.

The retained Swift changes are opt-in audit counters and SelfTest refresh/snapshot operations, not a speculative UI rewrite. They perform no per-render file I/O, and are disabled unless both SelfTest and `PHONEDOCK_APP_PERF` are enabled. Before/after counter snapshots and complete five-minute RSS timelines are in the app JSON evidence. Background/occluded app scheduling and the shared host limit interpretation of frame cadence and CPU differences.

### 4. Image-conversion thread tuning was not worth retaining

An alternating 22-pair experiment resized the same 1206 × 2622 PNG to 472 × 1024 JPEG at the existing quality/scale settings, comparing default ffmpeg threading with one decode/filter/encode thread. All 44 outputs were **24,565 bytes with identical SHA-256** (`8b7112c07225bd7bfe014997d18a013e701dc3b17651647efd950eada162538d`). The saving was only a few milliseconds, smaller than screenshot/host variation. No production media or quality setting changed. [Samples](performance/2026-11-23/media-thread-bench.json).

The simulator live path already shares a capture stream and deduplicates equal JPEGs with ETags. A static screen therefore delivers mostly 304s to `/frame`. HTTP poll frequency is not unique-image FPS. The multipart result separately counts received frames and distinct image hashes. Neither proves animation smoothness or physical display latency. AXe and simulator costs are outside daemon/app process CPU and remain a follow-up profiling target.

## Unmeasured paths and follow-up

No Android or physical-phone performance claim is made. Independent read-only Muse analysis identified the following paths; their magnitude needs an authorized device session before changing them:

| Path | Source observation and next measurement |
|---|---|
| Android screenshot fallback | `android-common.ts` captures full-resolution PNG over adb; `android-video.ts` fallback converts changed pictures through ffmpeg. Measure capture, conversion and device CPU separately on a static screen and scrolling; preserve image quality and fallback checks. |
| Android discovery and input | `android-device.ts` and `android-emulator.ts` independently enumerate adb devices; emulator listing scans AVD definitions. Input's online checks can repeat this work. Count spawns per list/tap with 0/5/20 AVDs before considering a shared snapshot; preserve hot-plug and transport validation. |
| Android crash polling | `AppModel` polls crashes on its existing cadence; Android reads Dropbox/logcat. Measure repeated unchanged reads before adding a bounded cache; do not hide new crash records. |
| Android UI quiet wait | `android-helper.ts` waits for 500 ms of quiet, with a 5 s bound; `android-common.ts` has recovery dumps. Profile static versus animated screens. These checks serve correctness and were not relaxed. |
| Android video | `android-video.ts` shares screenrecord, but keyframe handover can briefly have two encoders, and JPEG sizes can need separate ffmpeg decoders. Measure `screenSourceStats()` handovers/repairs and first-frame latency before changing recovery policy. |
| Physical iPhone HEVC | `LiveVideo.swift` waits for asynchronous decompression after each frame and compares full BGRA buffers to suppress repeats; H.264 uses a different direct display path. Profile static/blinking/scrolling HEVC with the existing video counters and renderer-queue sample before changing duplicate suppression or decoder ordering. The simulator JPEG test does not exercise this path. |

A dedicated, quiet-host animation workload is the next useful Mac measurement. Do not turn this background static-screen audit into a claim about 60 fps interactive scrolling, large device lists, long-term leak freedom or every supported backend.

## Reproduction

`scripts/perf/` contains the actual measurement harnesses. Run Apple/simulator measurements on a compatible Mac. Use a new scratch directory, the designated private port/filter, and only a newly created `pdtest-perf-*` simulator. Put `{"udid":"<owned test simulator UDID>"}` in `<scratch>/device.json`, a copy of the release bundle at `<scratch>/PhoneDock.app`, and export `PHONEDOCK_PERF_DIR=<scratch>`.

1. Record `git rev-parse HEAD`, Node version, Xcode/simulator inventory and host pressure. Install with `npm ci` as required; queue Apple release builds and bundling through Baton. Copy the built binary and bundled daemon into the scratch bundle and ad-hoc sign it. Add the opt-in counters to the baseline too; use the same settings for both builds.
2. `node scripts/perf/daemon.mjs <label> src/daemon/main.ts <cli-entry>` collects HTTP/MCP/frame measurements, then prints `READY_FOR_APP` and retains its own daemon. Use `src/cli/main.ts` for the original source CLI and `bin/phonedock.mjs` for the new bootstrap. Pin the same Node executable in both runs.
3. `node scripts/perf/stream.mjs <label>` measures multipart arrival cadence against that daemon. `python3 scripts/perf/app.py <label> 300` measures the copied app and exports/restores preferences before/after its run, comparing parsed plists exactly. The app harness stops its own app on failure as well.
4. `node scripts/perf/cli.mjs <before-launcher> <after-launcher>` alternates source shell launchers against the same daemon, pins child Node with `PHONEDOCK_NODE`, and records warm and first-pair results. Keep separate original/current source trees or a same-directory original CLI entry with working relative imports. An external `NODE_COMPILE_CACHE` must not inadvertently enable caching for the original launcher; the harness removes it from the before environment.
5. Stop the measurement parent with SIGTERM **after** `READY_FOR_APP`; its finally block stops its own daemon. Shut down/delete only the recorded test UDID, remove only the temporary bundle, compare final preferences with the original backup, and retain the JSON evidence. Do not run a second daemon while the port is occupied.

The app harness's in-process screenshot verifies the layout/frame but can omit native layer-backed sidebar pixels. Both in-process and window-server captures were inspected. Background capture omitted native sidebar/chrome pixels, so full foreground visual QA remains unverified. Screenshots and full `sample`/profile logs are retained locally as audit artifacts; committed JSON omits local paths and tokens. No source text, user devices or user application contents are present in the benchmark fixtures.

## Verification and cleanup

| Check | Result |
|---|---|
| Required local dependency install | `npm ci` completed once in this worktree, through Baton. |
| Focused Node checks | 18 passed on Instabox / Node 24.22.3; includes source launcher, cache engagement, override errors, inventory, frame sharing and late-provider SSE publication. The discovery regression was confirmed red before the fix (2 reads versus expected 1). |
| TypeScript | Final `npx tsc --noEmit -p .` passed on Instabox. |
| macOS release app | Final release build passed, 29.20 s after queue admission. |
| Bundles | Daemon and CLI bundles built. Copied/ad-hoc signed bundle verified. Actual bundled daemon health, filtered listing and 1206 × 2622 PNG screenshot passed; bundled CLI MCP `list_devices` passed. Original/new/bundled help was byte-identical (6,367 characters). |
| Live Mac app | Both five-minute background runs passed SelfTest; selected simulator and frame were inspected in screenshots. Full foreground visual QA remains unverified under the no-window constraint. |
| Independent review | Muse via YoYo completed read-only review, no blockers. Late-publish, cache-activation and override-exit coverage was strengthened after its feedback. Counter scope and required-snapshot validation are documented above. |
| Full suite | Not run locally, as required. The PR [test workflow](../.github/workflows/test.yml) owns Node 24/26 full suites, mandatory sidecar checks, Python checks and bundle validation. Consult the PR checks for the actual CI status. |
| Source hygiene | `git diff --check` and Node syntax checks for the retained JS harnesses passed. Temporary original CLI copies were removed. |
| Runtime cleanup | Owned source/bundled daemons stopped; 47433 has no listener. The exact owned simulator was shut down and deleted; available simulator count returned to 37. Temporary app bundle, baseline binary, scratch home and task caches deleted; no owned AXe capture remained. |
| Preferences | Each app run's backup/restored parsed plists matched. Final `dev.phonedock.app` export matched the original pre-audit backup exactly. |

[Verification and cleanup evidence](performance/2026-11-23/verification.json). The default daemon, existing devices and forbidden parallel-work paths were not changed. Measurement JSON, screenshots and profiles are retained; temporary runnable resources were removed.

