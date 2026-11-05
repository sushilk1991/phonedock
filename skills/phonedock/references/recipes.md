# PhoneDock recipes

Fuller versions of the recipes in SKILL.md. Tool names are PhoneDock's MCP tools; argument names are exact.
Pass `device` explicitly whenever more than one device is in play.

## Check a login screen

1. `list_devices`; use the device the user named, or `acquire_device platform="ios"`.
2. `launch_app app_id="com.example.app"` then `wait_for until="visible" text="Sign in"`.
3. `get_ui`: check the fields, labels, placeholders and buttons the user asked about. `screenshot` if the
   question is visual (alignment, contrast, truncation, dark mode).
4. Test credentials from the user only. In one `batch`:
   `fill target="Email" value=…` → `fill target="Password" value=… secret=true submit=true` →
   `wait_for until="visible" text="<what success shows>" timeout_ms=15000` → `get_ui`.
5. Error paths: an empty submit, a wrong password (`value="wrong"` is fine to type: it isn't a real secret), and
   check the message text each time.
6. A Face ID, 2FA or CAPTCHA screen appears: `request_human reason="Complete the 2FA step for <app>, then press Done"`.
7. Report: what you checked, what the screen said, pass or fail for each, and screenshots if you saved any.

## Build, install and launch your app

- **iOS simulator.** Build for the simulator, e.g.
  `xcodebuild -scheme App -sdk iphonesimulator -configuration Debug -derivedDataPath build build`, then
  `install_app path="<abs>/build/Build/Products/Debug-iphonesimulator/App.app"`. Device builds (`.ipa` for
  `iphoneos`) don't run in the simulator.
- **Android emulator.** `./gradlew assembleDebug`, then `install_app path="<abs>/app/build/outputs/apk/debug/app-debug.apk"`.
- `list_apps` shows the installed id; `launch_app app_id=…`; `get_foreground_app` confirms it's in front.
- After a code change: rebuild, `install_app` again (it replaces the app), `terminate_app` + `launch_app`.
- Start from a known state: `app_data action="save" app_id=… name="fresh"` once, `action="restore"` before each run.
  For the whole device: `snapshot_device action="save" name="clean"` / `action="restore"`.

## PR evidence

1. Put each state on screen, then `screenshot save_to="<abs>/evidence/01-<state>.png"` (full resolution, no image
   comes back, so it costs no context).
2. Motion or a bug that needs time: `record_screen action="start" max_seconds=60`, do the steps,
   `record_screen action="stop"` (returns the `.mp4` path and size).
3. Note device name, model and OS from `list_devices` with each file.
4. Attaching files to the PR or posting them anywhere needs the user's OK.

## Debug a crash

1. Reproduce with the smallest set of steps; note the time.
2. `list_crashes since="15m"` (optionally `app_id=…`) → `get_crash crash_id=…` for the exception, signal and the
   crashed thread (`full=true` for everything).
3. `get_logs filter="<process or tag>" lines=500` around that time.
4. `get_foreground_app` shows whether the app died or just went to the background.
5. Report the steps, the top frames, the log lines that matter, and what you think the cause is.

## Light/dark, rotation and text checks

- Find out the current values first (`set_appearance` reports what it was; the CLI's `appearance <id>` shows it).
- `set_appearance appearance="dark"`, then `screenshot`; `rotate orientation="landscape"`, then `get_ui` or
  `screenshot` (coordinates change after rotating); back to `portrait` and the original appearance at the end.
- Text size: `device_settings textSize="largest"` (the biggest accessibility size), screenshot the same screens,
  then `textSize="default"`. Add `increaseContrast=true` (and `boldText=true` on Android) for a contrast pass.
- Look for clipped text, low contrast, wrong colours and layouts that don't adapt.

## The same flow on Android and iOS

1. One device per platform: `acquire_device platform="android"` and `acquire_device platform="ios"` (or create
   them, e.g. `create_device backend="android-emulator" name="pd-a" profile="pixel_9" boot=true`).
2. Run the same steps on each, naming `device` in every call (or in the `batch`).
3. Prefer text selectors (`tap text=…`, `fill target=…`): they usually work on both. Ids differ: Android
   resource-ids vs iOS accessibility identifiers.
4. Report per platform. Platform differences (a Back key on Android, `go_back` tapping the nav bar on iOS) aren't
   failures unless the user asked about them.

## App Store screenshots

1. Create the models the store asks for (`list_profiles backend="ios-simulator" filter="Pro Max"`, and an iPad if
   needed), `boot=true`.
2. Set the scene: `set_appearance`, sample data in the app, deep links with `open_url`, `set_location` if maps show.
3. `screenshot save_to="<abs>/appstore/<device>-01.png" format="png"` with no `max_size`, so the image is full size.
4. Uploading to App Store Connect is the user's job, or needs their explicit OK.

## Performance loop

Use this for unattended tuning of one slow, repeatable flow: a screen that hangs, a list that stutters, a
slow launch-to-content.

1. Install and open the build you're measuring (or pass `launch=true`). Make the flow repeatable: a `batch`, or a
   flow file from `save_flow`.
2. `start_trace app_id="com.example.app"`. The default works:
   * iOS: xctrace with "Time Profiler", plus Hangs.
   * Android: perfetto plus gfxinfo frame stats.
   `template="Animation Hitches"` and other names from `xcrun xctrace list templates` also work.
   `time_limit_sec` defaults to 60.
3. Drive the flow, the same way every time.
4. `stop_trace`. Read:
   * `Hangs:` (iOS: count, longest, by severity);
   * the main-thread hot spots, where "Your code on the main thread" is what you can change;
   * the triage excerpt: what the main thread did during each hang;
   * Android: janky % and p90/p99 frame time.
5. Fix the biggest item: move work off the main thread, cache, avoid re-layout. Then rebuild, `install_app`,
   `terminate_app` + `launch_app`, and repeat steps 2–4 with the same app and template.
6. The new summary has `vs <traceId>: hangs 1 → 0 (-1) · mainThreadMs 1340 → 210 (-1130)`. Keep the change if
   the metric you targeted moved and nothing else got worse. Runs vary, so trace twice before trusting a small
   difference.

Going deeper uses the files the summary lists:
* `xcrun xctrace help` and `man xctrace` cover `show`, `export` and `triage` on the `.trace`; for example,
  `xctrace triage <trace> --style hangs` prints the full report.
* Xcode 27.2's own coding agent has an xctrace skill; use it if you're running there.
* Android: open the `.perfetto-trace` in https://ui.perfetto.dev.

On a real iPhone, trace only development builds the user asked you to measure.
CLI: `phonedock trace start <id> --app <id>` … `phonedock trace stop <id>`, or
`phonedock trace run <id> --app <id> --flow flow.yaml`.

## Multi-agent etiquette

- `acquire_device` before input when others may share the Mac; `release_device` when done.
- `lease_conflict` naming another agent: wait and retry, or use another device. Naming the person: they took over;
  wait, or `request_human` to ask for it back. Never try to take it.
- Reading (`get_ui`, `screenshot`) needs no lease.
