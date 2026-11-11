# Running PhoneDock flows in CI

A flow is a YAML regression test, usually saved from an agent's session (`save_flow`, or `phonedock flow save`). Format
and runner: [API.md › Flows](API.md#flows). This page shows how to run flows before you push and on every pull request.

```sh
phonedock test flows/ --device <id> --junit junit.xml --artifacts phonedock-artifacts
```

* Exit code **0** only when every flow that ran passed (and at least one ran), **1** otherwise, **2** for usage errors.
* `--junit` writes one `<testcase>` per flow (the steps go in `<system-out>`), which most CI systems display.
* Every run writes a self-contained, script-free `report.html`; suite runs also write a combined report at the
  artifacts root. `--capture-steps=true` adds before/after screenshots and action markers; leave it off when the
  extra screenshot latency is unnecessary.
* On failure, `<artifacts>/<flow name>/` holds `failure.png`, `ui.txt` / `ui.json` (the UI tree), `logs.txt` (device
  log), `app.log` (the flow's app), `steps.txt` and `result.json`. Upload that folder.
* Flows with `platform: ios` are skipped on Android devices and the other way round; `minOS` skips older systems.
  `--platform android|ios` runs only one platform's flows.
* `${VAR}` in a flow comes from the environment (or `--env NAME=VALUE`). Typed secrets that `flow save` saw are
  written as `${SECRET_1}`, …: set them from CI secrets. Known secret text is redacted in textual reports and
  diagnostics, but screenshot pixels remain unchanged. Review artifacts before publishing them.
* `--retries 1` re-runs a failed flow once. Use it for a flaky backend, not to hide a flaky app.

The example flows in [`fixtures/flows/`](../fixtures/flows) were saved from agent sessions on the sample app
(`fixtures/android-sample`) and on iOS Settings, and pass with `phonedock test`.

## Repository checks and native Python

The repository test workflow is configured for Node 24/26 with Python 3.12, installs `pymobiledevice3==11.49.2`, and sets
`PHONEDOCK_REQUIRE_SIDECAR_TESTS=1` so missing dependencies cannot silently skip fake sidecar protocol tests.
It also runs typechecking, TS tests, Python SDK transport tests, sidecar syntax validation and bundling.
Native iPhone sidecars require Python 3.11+ because they use `asyncio.timeout`; installing pymobiledevice3 into
an older system Python does not satisfy that requirement. Fake protocol tests do not validate physical hardware.

## Visual baselines and deterministic setup

CLI and MCP `run_flow` share the visual engine. FFmpeg is required: the default compares full-resolution RGBA,
not a grayscale thumbnail. `tolerance: 0.02` permits 2% changed pixels after ignored regions; `pixelThreshold: 16`
is the per-channel difference threshold. Use full-resolution screenshot pixels for ignore rectangles:

```yaml
- screenshot:
    name: welcome
    baseline: baselines/welcome.png
    tolerance: 0.02
    pixelThreshold: 16
    ignore:
      - { x: 0, y: 0, width: 1200, height: 90 }
```

Baseline paths are relative to the flow file; inline flows use the current directory. `--baseline-root` (default
current directory) confines reads and writes, including symlink targets. Missing baselines fail in the default
`compare` mode. Record reviewed initial baselines explicitly, and use `update` only when accepting changed output:

```sh
phonedock test flows/ --device <full-id> --baseline-root . --baseline-mode record
phonedock test flows/ --device <full-id> --baseline-root . --baseline-mode compare
# After reviewing an intentional visual change:
phonedock test flows/ --device <full-id> --baseline-root . --baseline-mode update
```

MCP uses `baseline_root`, `baseline_mode` and `capture_steps`; TS `runFlowFiles` uses `baselineRoot`, `baselineMode`
and `captureSteps`. `record` creates missing baselines and compares existing ones. `comparison: thumbnail`
explicitly selects the previous 64-pixel grayscale approximation. Missing FFmpeg, dimension changes, malformed
images and a mask that excludes every pixel fail the comparison rather than skipping it.

On a dedicated simulator/emulator, read `phonedock environment <id>` before applying permission grants,
status-bar overrides or media-library imports. Clear overrides and restore the intended test state afterward.
Only advertised services are supported. There are no physical-phone pre-grants, virtual-camera/QR injection, or
physical biometric bypasses. iOS biometric simulation uses experimental private notification recipes; Android
fingerprint match/fail requires enrollment first. Run separate permission-prompt tests so pre-granting does not
hide application bugs.

`phonedock doctor` checks host prerequisites without contacting devices. `phonedock audit <id>` supplies heuristic
UI warnings, not an accessibility compliance result. Debug-enabled Android WebView diagnostics are read-only and
limited to that WebView; they do not intercept native app HTTP or inspect iOS WebViews.

For shared hosts, isolate jobs by device and use upgraded daemons sharing one `PHONEDOCK_HOME` for SQLite ownership
coordination. Different homes, older daemons and external tools are outside that protection. A different port alone
does not isolate the physical device. Inventory can be partial while a provider is pending: inspect `/v1/inventory`
and use full canonical IDs to target a known backend directly. TS/Python friendly name, native-ID and prefix
resolution waits up to five seconds for initial provider results, then reports `inventory_pending` if warming or
`inventory_incomplete` after failed/timed-out initial discovery.

If input loses its response, preserve the request ID and owner, read `request-result <id> <requestId>`, and inspect
the screen. Receipts are device/owner-scoped: completed/dead records expire after 24 hours, while live running
receipts remain protected beyond that (including failed completion persistence). The 1,024-file bound returns
`503 request_store_full` before new input instead of evicting live receipts and risking replay. Unknown or interrupted
delivery must not automatically retry the input under a new ID. Whole-flow `--retries` is also a new execution:
use it only when resetting/repeating the workflow is safe.

For iPhone Duo simulators, primary-display screenshots, UI reads, media import and recording work. AXe input
routing was observed ineffective; affected input now returns `501 not_supported` / `not_sent`, with corresponding
per-device input capabilities removed. Use a single-display simulator for interactive CI. Duo streaming and
system gestures have not been validated.

## Before you push (local)

Keep one device for tests (don't use the one you work on), and reset it before the run so every run starts the same.

```sh
phonedock create --backend android-emulator --name test-pixel --profile pixel_9 --boot   # once
phonedock install test-pixel app/build/outputs/apk/debug/app-debug.apk
phonedock snapshot save test-pixel clean                                                 # once, in a known state
```

`.git/hooks/pre-push` (make it executable):

```sh
#!/bin/sh
# Run the PhoneDock flows before every push. Skip once with: git push --no-verify
set -e
phonedock snapshot restore test-pixel clean
phonedock install test-pixel app/build/outputs/apk/debug/app-debug.apk
phonedock test flows/ --device test-pixel
```

Or add `"test:flows": "phonedock test flows/ --device test-pixel"` to `package.json` scripts. `launch` steps stop the
app first, so a flow starts from the app's launch screen even without a snapshot. The app's saved data is
kept, though; restore a snapshot (or `phonedock appdata … restore`) when a flow needs a fresh install.

## GitHub Actions (macOS runner)

> **Untested in CI.** The workflow below follows what works on a Mac locally, but it has not been run on GitHub's
> runners. Expect to adjust the runner label, the simulator model and the system image. Known constraint: GitHub's
> hosted **Apple Silicon** runners don't offer nested virtualization, so the Android emulator may not start there;
> run the Android job on a self-hosted Mac (or a runner with hardware acceleration). iOS simulators don't need it.

```yaml
# .github/workflows/flows.yml  (UNTESTED IN CI: see docs/CI.md)
name: PhoneDock flows
on: [pull_request]

jobs:
  ios:
    runs-on: macos-15
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4

      # Install PhoneDock: from source (needs Node 24) ...
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - name: Install PhoneDock (source)
        run: |
          git clone --depth 1 https://github.com/<owner>/PhoneDock "$RUNNER_TEMP/phonedock"
          (cd "$RUNNER_TEMP/phonedock" && npm ci --omit=dev)
          echo "$RUNNER_TEMP/phonedock/bin" >> "$GITHUB_PATH"
      # ... or from the release DMG (the app bundles its own Node):
      # - name: Install PhoneDock (release DMG)
      #   env: { GH_TOKEN: "${{ github.token }}" }
      #   run: |
      #     gh release download --repo <owner>/PhoneDock --pattern 'PhoneDock-*.dmg' --dir "$RUNNER_TEMP"
      #     hdiutil attach "$RUNNER_TEMP"/PhoneDock-*.dmg -nobrowse -mountpoint /Volumes/PhoneDock
      #     cp -R /Volumes/PhoneDock/PhoneDock.app /Applications/ && hdiutil detach /Volumes/PhoneDock
      #     echo "/Applications/PhoneDock.app/Contents/Resources/bin" >> "$GITHUB_PATH"

      - name: Build the app for the simulator
        run: xcodebuild -scheme MyApp -sdk iphonesimulator -configuration Debug -derivedDataPath build build

      - name: Create and boot a simulator
        run: |
          phonedock daemon start
          phonedock images ios-simulator            # installed runtimes
          phonedock profiles ios-simulator          # device models
          RUNTIME=$(phonedock images ios-simulator --json | jq -r '[.[] | select(.installed)][0].id')
          phonedock create --backend ios-simulator --name ci-iphone --image "$RUNTIME" \
            --profile com.apple.CoreSimulator.SimDeviceType.iPhone-16 --boot

      - name: Install the app
        run: phonedock install ci-iphone build/Build/Products/Debug-iphonesimulator/MyApp.app

      - name: Run flows
        run: phonedock test flows/ --platform ios --device ci-iphone --junit junit-ios.xml --artifacts phonedock-artifacts

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: phonedock-ios
          path: |
            junit-ios.xml
            phonedock-artifacts

  android:
    runs-on: [self-hosted, macOS]        # or a hosted macOS runner with hardware acceleration (see the note above)
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - name: Install PhoneDock (source)
        run: |
          git clone --depth 1 https://github.com/<owner>/PhoneDock "$RUNNER_TEMP/phonedock"
          (cd "$RUNNER_TEMP/phonedock" && npm ci --omit=dev)
          echo "$RUNNER_TEMP/phonedock/bin" >> "$GITHUB_PATH"

      - name: Build the APK
        run: ./gradlew assembleDebug

      - name: Create and boot an emulator
        # PhoneDock finds the SDK through ANDROID_HOME / ANDROID_SDK_ROOT. Use the x86_64 image on Intel Macs.
        run: |
          phonedock daemon start
          IMAGE="system-images;android-36;google_apis;arm64-v8a"
          phonedock images install android-emulator "$IMAGE"
          phonedock create --backend android-emulator --name ci-pixel --image "$IMAGE" --profile pixel_9 --boot

      - name: Install the app
        run: phonedock install ci-pixel app/build/outputs/apk/debug/app-debug.apk

      - name: Run flows
        run: phonedock test flows/ --platform android --device ci-pixel --junit junit-android.xml --artifacts phonedock-artifacts

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: phonedock-android
          path: |
            junit-android.xml
            phonedock-artifacts

      - name: Delete the emulator
        if: always()
        run: phonedock rm ci-pixel --force
```

Notes:
* Devices boot headless (no window). Boot takes 30–90 s; `create … --boot` waits until the device is usable.
* `phonedock test` leases the device for the run. Upgraded daemons sharing its PhoneDock home enforce ownership;
  unrelated tools, older daemons and separate homes do not. On a shared self-hosted Mac, give each job its own device.
* Show JUnit results in the PR with any JUnit reporter action (for example `mikepenz/action-junit-report`).

## Reading a failure

```
Flow: Greet Ada (broken on purpose) (flows/greet-broken.yaml) on pdtest-flow-pixel (Android 16 (API 36))
  PASS  1  launch dev.phonedock.sample                             1.56s
  PASS  2  assert_visible "PhoneDock Sample"                       0.04s
  PASS  3  fill "Your name" = "Ada"                                1.97s
  PASS  4  tap "Greet"                                             0.93s
  FAIL  5  wait_for visible "Hello, Bob!"                         10.01s
           Expected "Hello, Bob!" to be visible within 10 s, but it never appeared.
           Screen now: TextView "PhoneDock Sample", EditText "Ada", Button "Greet", TextView "Hello, Ada!", …
           (2 later steps not run)
           Artifacts: phonedock-artifacts/greet-ada-broken-on-purpose
FAIL  Greet Ada (broken on purpose) (failed at step 5 of 7, 14.52s)

FAILED: 0 passed, 1 failed, 0 skipped (1 flow, 14.8s) on pdtest-flow-pixel
```

`Screen now` lists what was on screen when the step gave up, so most failures can be read without opening the
artifacts: here the app greeted "Ada", not "Bob". Open `failure.png` and `app.log` when the screen is unexpected.
If the app was never installed on the device, the `launch` step says so (`… isn’t installed on ci-pixel. Install it
before the run: phonedock install …`).

Use `GET /v1/metrics` to distinguish `phases["input.queue"]` from `phases["input.execute"]` and backend/route latency. Optional post-input UI enrichment is outside `input.execute`; compare the same workload before calling a change faster.
