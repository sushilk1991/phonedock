# pd-probe (`dev.phonedock.probe`)

Plain third-party Android probe app for measuring device, emulator, VM, root, and automation signals from an unprivileged app perspective. Built with plain Android SDK tools (no Gradle, no third-party libraries).

## Build

```sh
bash tools/android-probe/build.sh
```

Output: `tools/android-probe/build/pd-probe.apk` (the script prints its absolute path as the last line).

Overrides: `ANDROID_SDK_ROOT`, `BUILD_TOOLS` (default `36.0.0`), `PLATFORM` (default `android-36`), `JAVA_HOME`, `JAVAC_EXTRA_FLAGS`.

## Install, run, and pull reports

```sh
# Install
adb -s <serial> install -r tools/android-probe/build/pd-probe.apk

# Launch (runs all checks on a background thread; re-launching re-runs checks)
adb -s <serial> logcat -c
adb -s <serial> shell am start -n dev.phonedock.probe/.ProbeActivity

# Wait for completion line: "PDPROBE : done checks=<n> flagged=<m> path=..."
adb -s <serial> logcat -s PDPROBE:I

# Pull report.json (and touch.json after sending touch/key input)
adb -s <serial> pull /sdcard/Android/data/dev.phonedock.probe/files/report.json ./report.json
adb -s <serial> pull /sdcard/Android/data/dev.phonedock.probe/files/touch.json ./touch.json
```

## Report format

`report.json`:

```json
{
  "v": 1,
  "generatedAt": "2026-11-22T18:00:00Z",
  "sdk": 34,
  "checks": [
    { "id": "build.fingerprint", "group": "build", "value": "...", "flag": true, "why": "contains 'sdk_gphone'" },
    { "id": "telephony.imei", "group": "telephony", "value": null, "flag": false, "error": "SecurityException: ..." }
  ],
  "summary": {
    "total": 0,
    "flagged": 0,
    "byGroup": { "build": { "total": 0, "flagged": 0 } }
  }
}
```

`touch.json`: records up to the latest 400 `MotionEvent` and `KeyEvent` inputs received by `ProbeActivity`, rewritten after each gesture (`ACTION_UP` / `ACTION_CANCEL`) and key up, logging `PDPROBE touch events=<n>`.

## Check groups

- `build` — `android.os.Build` fields, ABIs, SoC (API 31+), radio version, `Build.VERSION.*`, `Build.getSerial()`
- `props` — 49 properties read via both `SystemProperties.get` (reflection) and `getprop` (diff-flagged), plus `props.suspicious` and `props.count`
- `files` — 32 emulator/VM artifact paths, `/proc/*` (`cpuinfo`, `version`, `meminfo`, `mounts`, `mountinfo`, filtered `maps`, `TracerPid`, `tty/drivers`, `partitions`, `cmdline`, `bus/input/devices`, `net/route`), and `/sys/*` (`thermal`, `power_supply`, `block`, `cpu`, `cpufreq`, `soc0`)
- `root` — `su` in `PATH`/standard dirs, `su -c id` (2 s timeout), `which su`, Magisk/root artifact paths, root/overlay mounts, root/hooking packages, SELinux (`getenforce`, `/sys/fs/selinux/enforce`)
- `telephony` — `TelephonyManager` state, operator/SIM info, privileged IDs (value or exception), `FEATURE_TELEPHONY`
- `sensors` — full sensor list, count, accelerometer presence, 1.5 s `SENSOR_DELAY_GAME` sampling of accelerometer/gyroscope/magnetometer with min/max/stddev
- `gl` — EGL 1.4 pbuffer context (ES 3 -> ES 2 fallback), `GL_*` and `EGL_*` strings, extension count
- `media` — `MediaCodecList` (hw/sw/vendor flags, AVC/HEVC encoders, hw video codec count) and `MediaDrm` Widevine properties
- `keystore` — EC P-256 `AndroidKeyStore` key generation with attestation challenge, cert chain length, root subject/SHA-256, security level
- `battery` — sticky `ACTION_BATTERY_CHANGED` extras and `BatteryManager` properties
- `network` — `NetworkInterface` enumeration, active network transports/capabilities, VPN, `LinkProperties`, `WifiManager`, HTTP proxy
- `features` — 26 named `hasSystemFeature` checks plus full `getSystemAvailableFeatures()` list
- `bluetooth` — `BluetoothAdapter.getDefaultAdapter()` presence
- `camera` — `CameraManager` camera count and per-camera characteristics (facing, hardware level, flash, pixel array, physical size, focal lengths, max JPEG)
- `display` — name, size, refresh rate, supported modes, HDR capabilities, metrics, cutout, rounded corners, and emulator profile check
- `input` — `InputDevice` list (ids, names, descriptors, vendor/product IDs, sources, virtual/external, keyboard type)
- `audio` — `AudioManager.getDevices(GET_DEVICES_ALL)`
- `packages` — emulator package scan (`QUERY_ALL_PACKAGES`), total count, Play Store (`com.android.vending`), GMS (`com.google.android.gms`), app installer
- `settings` — `Settings.Global`, `Settings.Secure`, `AccessibilityManager`, `ActivityManager` monkey/test-harness, `Debug` flags
- `system` — uptime, timezone, locale, `os.arch`, `os.version`, `java.vm.version`, total RAM, internal storage, CPU cores, `Os.uname()`
