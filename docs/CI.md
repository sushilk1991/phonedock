# Running PhoneDock flows in CI

A flow is a YAML regression test, usually saved from an agent's session (`save_flow`, or `phonedock flow save`). Format
and runner: [API.md › Flows](API.md#flows). This page shows how to run flows before you push and on every pull request.

```sh
phonedock test flows/ --device <id> --junit junit.xml --artifacts phonedock-artifacts
```

* Exit code **0** only when every flow that ran passed (and at least one ran), **1** otherwise, **2** for usage errors.
* `--junit` writes one `<testcase>` per flow (the steps go in `<system-out>`), which most CI systems display.
* On failure, `<artifacts>/<flow name>/` holds `failure.png`, `ui.txt` / `ui.json` (the UI tree), `logs.txt` (device
  log), `app.log` (the flow's app), `steps.txt` and `result.json`. Upload that folder.
* Flows with `platform: ios` are skipped on Android devices and the other way round; `minOS` skips older systems.
  `--platform android|ios` runs only one platform's flows.
* `${VAR}` in a flow comes from the environment (or `--env NAME=VALUE`). Typed secrets that `flow save` saw are
  written as `${SECRET_1}`, …: set them from CI secrets.
* `--retries 1` re-runs a failed flow once. Use it for a flaky backend, not to hide a flaky app.

The example flows in [`fixtures/flows/`](../fixtures/flows) were saved from agent sessions on the sample app
(`fixtures/android-sample`) and on iOS Settings, and pass with `phonedock test`.

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
* `phonedock test` leases the device for the run, so a second job or agent on the same Mac can't send input to it
  meanwhile. On a shared self-hosted Mac, give each job its own device name.
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
