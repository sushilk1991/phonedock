# Virtual Phones (Disguised Android Emulators)

PhoneDock can create ARM64 Android Emulator virtual devices that present a coherent, real-handset software identity (build fingerprint, hardware/SoC properties, serial number, IMEI, MAC addresses, Android ID, display cutout, front+back cameras, and no physical `qwerty2` keyboard) while continuing to run at near-native Hypervisor.framework speed with Google Play Store support.

This capability is an **opt-in disguise layer** inside the `android-emulator` backend — every standard PhoneDock feature (boot, shutdown, clone, snapshots, H.264 live video, UI tree, tap/swipe/pinch, shell, traces, leases, MCP, CLI, SDK) works identically.

---

## Quick start

### CLI

```sh
# Create and boot a disguised Pixel 8 (default profile & carrier)
phonedock create --backend android-emulator --name my-phone --disguise --boot

# Pick a specific sourced profile, carrier, and deterministic seed
phonedock create --backend android-emulator --name s24-eu \
  --disguise galaxy_s24 --carrier ee_uk --seed 0123456789abcdef0123456789abcdef --boot

# Clone gets a fresh, distinct identity (new IMEI, serial, MACs, Android ID, SIM IDs)
phonedock shutdown my-phone
phonedock clone my-phone my-phone-2
```

### HTTP API (`POST /v1/devices`)

Pass `options.disguise` in `DeviceSpec` (`true`, a profile ID string, or an object):

```json
{
  "backend": "android-emulator",
  "name": "my-phone",
  "boot": true,
  "options": {
    "disguise": {
      "enabled": true,
      "profile": "pixel_8",
      "carrier": "tmobile_us",
      "seed": "0123456789abcdef0123456789abcdef",
      "teardownMagisk": false
    }
  }
}
```

### MCP (`create_device`)

```json
{
  "backend": "android-emulator",
  "name": "my-phone",
  "disguise": "pixel_8",
  "carrier": "tmobile_us",
  "boot": true
}
```

Disguised devices report the target phone's model in `Device.model` (for example `Pixel 8`) and expose their configured identity summary in `Device.meta.disguise` (`profile`, `carrier`, `imei`, `serial`, `wifiMac`, `btMac`, `phoneNumber`, `androidId`) as well as `GET /v1/devices/:id/info`.

---

## Sourced handset profiles

Profiles live verbatim in [src/core/profiles.json](../src/core/profiles.json) and are validated at load time by [src/core/device-profiles.ts](../src/core/device-profiles.ts). Every build fingerprint, TAC, and IEEE OUI is traced to primary sources (public firmware dumps, Google factory/OTA image metadata, GPUInfo reports, and IEEE MA-L registries).

| Profile ID | Model | Android / API | Build ID | Screen | RAM | Verified Bootloader / Baseband |
|---|---|---|---|---|---|---|
| `pixel_8` (default) | Google Pixel 8 (`shiba`) | Android 14 (API 34) | `AP2A.240605.024` | 1080×2400 @ 420 dpi | 8192 MB | Yes / Yes |
| `pixel_8a` | Google Pixel 8a (`akita`) | Android 14 (API 34) | `AP2A.240905.003.A1` | 1080×2400 @ 420 dpi | 8192 MB | Yes / Yes |
| `pixel_7a` | Google Pixel 7a (`lynx`) | Android 14 (API 34) | `AP2A.240905.003` | 1080×2400 @ 420 dpi | 8192 MB | Yes / Yes |
| `galaxy_s23` | Samsung Galaxy S23 (`SM-S911B`) | Android 14 (API 34) | `UP1A.231005.007` | 1080×2340 @ 480 dpi | 8192 MB | Unverified (omitted) |
| `galaxy_s24` | Samsung Galaxy S24 (`SM-S921B`) | Android 14 (API 34) | `UP1A.231005.007` | 1080×2340 @ 480 dpi | 8192 MB | Unverified (omitted) |
| `oneplus_12` | OnePlus 12 (`CPH2581`) | Android 14 (API 34) | `UKQ1.230924.001` | 1440×3168 @ 640 dpi | 12288 MB | Unverified (omitted) |

**Honesty rules for profile data:**
- **No fabricated OEM strings.** Fields marked `null` / `unverified` in `profiles.json` (for example `ro.bootloader` and `gsm.version.baseband` on Galaxy S23/S24 and OnePlus 12, or `ro.build.host` on Pixel 8a) are omitted rather than invented.
- **No API-level lying.** PhoneDock never spoofs `ro.build.version.sdk` or `ro.build.version.release` away from the underlying system image. Creating a disguised device without `--image` picks an installed `google_apis_playstore;arm64-v8a` image matching `profile.sdk`; passing an image with a different API level fails explicitly with `sdk_mismatch`.
- **Serial fallback.** Because primary specs did not confirm exact OEM serial alphabets for all six models, serial generation falls back to an AOSP CTS-compliant alphanumeric alphabet (`^[0-9A-Za-z]{6,20}$`, length 11 for Samsung per official support docs, 14 for Pixel, 12 for OnePlus) and flags `serialRuleSource: 'cts-fallback'`.

---

## How it works

### 1. Deterministic device identity (`src/core/device-identity.ts`)

At `create()` time, PhoneDock derives a complete `DeviceIdentity` from `(profile, carrier, seed)` using HMAC-SHA256 with unbiased rejection sampling (never `% n`):
- Valid Luhn-checked 15-digit **IMEI** (and `imei2` on dual-SIM profiles) starting from one of the profile's verified 8-digit TACs.
- **Serial number**, 16-hex **Android ID**, distinct unicast globally-administered **Wi-Fi and Bluetooth MACs** using maker-level IEEE OUIs, UUID v4 **boot ID**, and carrier-consistent **IMSI**, Luhn-checked **ICCID**, and E.164 **phone number**.
- Persisted in `<avdDir>/phonedock.json` under `disguise`.
- **`clone()`** regenerates a brand-new `DeviceIdentity` (new random seed, same profile and carrier) and clears `overlaySha256`, so the clone cold-boots as a distinct phone on first launch.

### 2. Two-tier ramdisk cache (`src/backends/android-disguise.ts`)

All artifacts are cached under `$PHONEDOCK_HOME/virtual-phones/`:

1. **Tier 1 — Per-image Magisk base ramdisk (`base/<imageSlug>-<stockSha12>-magisk-v31.1.img`):**
   - Downloads the pinned upstream Magisk `v31.1` APK into `magisk/Magisk-v31.1.apk` and verifies its SHA-256 (`89cefac0a318afa39fb3880c45c87b036c05bc1ebf02a7a715b7f8d7c26ac6e7`) before extraction.
   - Extracts Magisk's arm64 binaries (`magisk`, `magiskboot`, `magiskinit`, `init-ld`) via `/usr/bin/unzip` (argv array).
   - Once per `(system-image, ramdisk.img SHA-256, Magisk version)`, boots a transient **`-read-only -no-snapshot`** headless stock emulator, pushes the arm64 binaries and stock `ramdisk.img` to `/data/local/tmp/pdvp`, runs `magiskboot` in-guest, pulls `ramdisk.magisk.img` atomically into the Tier 1 cache, cleans up `/data/local/tmp/pdvp`, and shuts down the transient VM. Every subsequent disguised phone on the same system image reuses this cached base with zero bootstrap overhead.

2. **Tier 2 — Per-device overlay ramdisk (`ramdisks/<baseSha12>-<overlaySha12>.img`):**
   - [src/core/virtual-phone-overlay.ts](../src/core/virtual-phone-overlay.ts) renders the device's `overlay.d/` scripts and packs them into a deterministic SVR4 `newc` CPIO archive (`uid=0`, `gid=0`, `mtime=0`, sorted paths) compressed with deterministic gzip (`MTIME=0`, `OS=Unix`) in pure Node (`node:zlib`, no host `cpio` CLI dependency).
   - Concatenating `ramdisk.magisk.img || overlay.cpio.gz` produces the final `-ramdisk` image (the Linux kernel unpacks concatenated gzipped initramfs archives in order).
   - Because the identity scripts are baked directly into the ramdisk, the device boots disguised on its very first boot — no post-boot file push, no second reboot, and no persistent root backdoor daemon (`pd-rootd` is never installed in production).
   - `boot()` passes `-ramdisk <cachedPath>` and forces `-no-snapshot-load` whenever `overlaySha256` changes (first boot, clone, or updated overlay scripts), committing `overlaySha256` to `phonedock.json` only after `sys.boot_completed=1`.

### 3. Two-stage boot hooks (`overlay.d/pd.rc`)

- **Stage 1 — `post-fs-data` (synchronous, pre-zygote):**
  Rewrites all `ro.product.*`, `ro.build.*` (including per-partition fingerprints such as Samsung S23's Android 13 vendor freeze), `ro.hardware`, `ro.boot.hardware`, `ro.board.platform`, `ro.soc.*`, verified `ro.bootloader` / `gsm.version.baseband`, `ro.serialno`, and `ro.sf.lcd_density` via Magisk's `resetprop` before Zygote starts so `android.os.Build` inherits the real phone identity. Preserves early-boot HAL properties (`ro.kernel.qemu`, `ro.boot.qemu`, `ro.boot.qemu.virtiowifi`, `ro.boot.qemu.hwcodec.*`, `ro.boot.qemu.gltransport.*`, `vendor.qemu.vport.*`) so Wi-Fi (`wlan0`), hardware video codecs, Bluetooth, and KeyMint initialize cleanly.
- **Stage 2 — `boot-completed` (one-shot `service pd-boot-disguise` on `sys.boot_completed=1`):**
  Rewrites HAL-sensitive properties post-boot (`ro.hardware.gralloc`, `ro.hardware.power`, `ro.hardware.vulkan`, `dalvik.vm.isa.arm64.variant`, `net.bt.name`), runs a two-pass `resetprop --delete` sweep (immediately and again after `sleep 4` to catch late `boot_completed` init services such as `qemu-props-bootcomplete` and `ranchu-setup`), aligns `settings.global.device_name`, `development_settings_enabled=0`, `settings.secure.android_id`, and `bluetooth_name`, sets realistic battery level/status/temperature (`dumpsys battery set`), enables Android's built-in punch-hole display cutout overlay, and uninstalls non-essential `com.android.emulator.multidisplay` for user 0. Leaves `adb_enabled=1` intact so PhoneDock retains ADB control.

### 4. AVD hardware configuration (`config.ini`)

At `create()`, disguised AVDs default screen dimensions, DPI, and RAM from the chosen `DeviceProfile`, set `hw.device.name` and `hw.device.manufacturer`, disable the emulator's physical `qwerty2` keyboard (`hw.keyboard=no`), and enable both front and back emulated cameras (`hw.camera.front=emulated`).

---

## Measured scoreboard (`pd-probe`)

PhoneDock includes a standalone third-party measurement APK ([tools/android-probe](../tools/android-probe), package `dev.phonedock.probe`, 279 checks across 20 groups) that inspects the running device strictly as an unprivileged app.

Measured apples-to-apples on Apple Silicon (`system-images;android-34;google_apis_playstore;arm64-v8a`, equal ~2,000 s uptime: stock 2,052 s vs. disguised `pixel_8` 1,982 s):

- **Stock Android Emulator:** **59 / 279** flagged
- **Disguised virtual phone (`pixel_8`):** **36 / 279** flagged
- **Removed by disguise:** **30** stock tells — every obvious `Build` field (7/7), every system property (19/19, including `props.suspicious`), `display.emulator_profile`, `camera.count`, `audio.devices`, and `settings.global.device_name`
- **Added by disguise:** **7** flags — **all 7 stem from Magisk root**:
  - `root.artifacts`, `root.mounts`, `root.su_paths` (**3**) — Magisk's runtime presence (reducible via opt-in `teardownMagisk`, best-effort; see below)
  - `telephony.network_operator`, `telephony.network_operator_name`, `telephony.sim_operator`, `telephony.sim_operator_name` (**4**) — Magisk's ramdisk patch currently drops the emulator's virtual modem port (`vport9p1`), leaving the SIM absent (see *Telephony* below)
- **Remaining 36 flags breakdown:** **29** true kernel/hardware hard-floor tells (identical to stock, unavoidable in QEMU/Android Emulator from userspace) + **3** Magisk root + **4** Magisk-induced telephony. Without Magisk's side effects, the disguise adds zero tells beyond the hard floor.

| Probe group | Checks | Stock flagged | Disguised flagged | Notes |
|---|---:|---:|---:|---|
| `build` | 25 | 7 | **0** | All `android.os.Build` fields, bootloader, SoC, and `getRadioVersion()` clean |
| `props` | 51 | 19 | **0** | All 49 tracked props + `props.suspicious` clean (two-pass post-boot sweep) |
| `display` | 12 | 1 | **0** | Punch-hole display cutout overlay clears `display.emulator_profile` |
| `camera` | 2 | 1 | **0** | Front + back emulated cameras enabled |
| `audio` | 1 | 1 | **0** | Audio device product names report `Pixel 8` |
| `settings` | 20 | 2 | **1** | `device_name`, `development_settings_enabled=0`, `android_id` clean; `adb_enabled=1` kept intentionally for PhoneDock |
| `bluetooth` | 1 | 0 | **0** | Adapter present |
| `system` | 11 | 0 | **0** | Clean |
| `files` | 52 | 12 | **12** | Hard floor: `/sys` goldfish/virtio, `/proc/cpuinfo` (`0x61`), `/proc/self/mounts`, `/vendor` ranchu files |
| `sensors` | 6 | 4 | **4** | Hard floor: `Goldfish` sensor names + static zero-variance readings |
| `network` | 6 | 3 | **3** | Hard floor: QEMU slirp NAT (`10.0.2.x`, DNS `10.0.2.3`), virtual Wi-Fi RSSI `-50`, API 34 `NetworkInterface` restriction |
| `gl` | 7 | 2 | **2** | Hard floor: `Google (Apple)` / `Android Emulator OpenGL ES Translator` |
| `media` | 7 | 2 | **2** | Hard floor: Widevine **L3** + `c2.goldfish.*` decoder names (`hw_video_codecs_count = 3` works) |
| `keystore` | 5 | 1 | **1** | Hard floor: `SECURITY_LEVEL_SOFTWARE` (`attestation.succeeded = true` works) |
| `battery` | 14 | 1 | **1** | Hard floor: QEMU `goldfish_battery` hardcoded `5000 mV` (`level`/`status`/`plugged`/`temp` overridden) |
| `features` | 27 | 1 | **1** | Hard floor: missing `android.hardware.nfc` |
| `input` | 1 | 1 | **1** | `qwerty2` keyboard removed; kernel `virtio_input_multi_touch_*` remains |
| `packages` | 5 | 1 | **1** | `com.android.emulator.multidisplay` removed; radio/connectivity system overlays kept |
| `root` | 8 | 0 | **3** | Magisk presence (`su_paths`, `artifacts`, `mounts`); SELinux remains `Enforcing` |
| `telephony` | 18 | 0 | **4** | Magisk ramdisk drops `vport9p1` modem (known v1 limitation; see below) |
| **Total** | **279** | **59** | **36** | **−30 stock tells removed · +7 root-induced tells** |

### Telephony (known v1 limitation)

Patching the Android 14 Play Store ramdisk with Magisk currently prevents the emulator from attaching its virtual modem port (`vport9p1` / `vendor.qemu.vport.modem`), even with an empty overlay and no property rewrites (`reference-ril` logs `opening qemu_modem_port -1`, radio stays `UNAVAILABLE`, and the SIM reads absent / `OUT_OF_SERVICE`). By contrast, booting the exact same AVD with `-ramdisk <unmodified stock ramdisk.img>` attaches `vport9p1`, loads the SIM, and registers `IN_SERVICE`.

As a result, disguised virtual phones currently have **no cellular radio** (empty `TelephonyManager` network/SIM operator names), while **Wi-Fi (`wlan0`) and Google Play Store work normally** — covering Wi-Fi-connected app automation and research flows (browsing, social apps, media uploads). The deterministic SIM identifiers (`carrier`, `imsi`, `iccid`, `phoneNumber`, default `tmobile_us` / `310260`) are already generated and persisted in `phonedock.json` so they are ready once the Magisk ramdisk vs. ranchu modem interaction is resolved.

---

## Root & opt-in `teardownMagisk`

Disguised virtual phones use Magisk `v31.1` solely as a pre-zygote init/resetprop loader — PhoneDock does not install the Magisk Manager app, does not leave a root backdoor daemon running, and keeps SELinux globally **Enforcing**.

However, Magisk's runtime presence still leaves detectable root artifacts (`root.su_paths` for `/debug_ramdisk/su`, `root.artifacts` for `/debug_ramdisk/.magisk`, and `root.mounts` for `magisk`-sourced tmpfs mounts).

### Why `teardownMagisk` is opt-in (`false` by default) and best-effort

Setting `options.disguise.teardownMagisk: true` appends a post-boot teardown step to `pd-boot-completed.sh` that:
1. Invokes Magisk v31.1's supported `magisk --stop` RPC (which runs `denylist_handler(-1)`, restores `native_bridge`, lazily detaches Magisk mounts via `MNT_DETACH`, and exits `magiskd` cleanly).
2. Checks `/proc/self/mounts` for any remaining `^magisk ` mount on `$MAGISKTMP` before running fallback `rm` + `umount -l` — ensuring a stock Android 14 `/debug_ramdisk` tmpfs is never detached.

**Do not treat `teardownMagisk: true` as making the VM undetectably stock/unrooted:**
- Magisk's patched SELinux policy remains loaded in the kernel until reboot (`getenforce` still reports `Enforcing`, but the policy is not stock).
- Already-spawned processes or private mount namespaces may retain references to detached mounts.
- The host-side cached ramdisk remains patched and re-runs Magisk init on the next boot.
- For per-app mount isolation without stopping `magiskd`, Magisk's built-in **enforced DenyList** (`magisk --denylist add <pkg> <proc>` + `magisk --denylist enable`) is a supported alternative, with the same policy-level caveats.

Note on stock Android 14 directories: bare `/debug_ramdisk` (created by AOSP first-stage init) and bare `/data/adb` (created by stock `adbd`) exist on untouched stock Android 14 images; `pd-probe` checks only actual root-tool children (`/data/adb/magisk`, `/data/adb/modules`, `/debug_ramdisk/.magisk`, `/sbin/.magisk`, `/cache/.disable_magisk`, `/system/app/Superuser.apk`).

---

## Honest limits (the kernel & hardware floor)

Userspace property/overlay disguising removes the broad set of `Build`, system-property, settings, display, camera, audio, and keyboard tells that catch stock Android emulators, but it **cannot** erase signals backed by the Linux kernel, QEMU virtual hardware, or missing secure hardware. Apps that inspect these deeper layers will still distinguish an emulator from a physical handset:

| Category | Residual signal | Why it cannot be hidden cleanly from userspace |
|---|---|---|
| **Kernel & `/sys` / `/proc`** | `/sys/module/goldfish_pipe`, `/sys/module/virtio_blk`, `/sys/bus/virtio/devices`, `/sys/class/virtio-ports`, `/sys/devices/virtual/misc/goldfish_address_space`, `/proc/cpuinfo` (Apple host implementer `0x61`, no `Hardware:` line), `/proc/self/mounts` (`virtio` entries), `/vendor` goldfish/ranchu files | Exposed directly by the guest Linux kernel, QEMU virtio drivers, and read-only vendor partition; hiding them requires a custom kernel, hypervisor changes, or Zygisk syscall hooking. |
| **OpenGL ES / GPU** | `GL_VENDOR` (`Google (Apple)`), `GL_RENDERER` (`Android Emulator OpenGL ES Translator (...)`) | Reported directly by the host gfxstream/EGL translator (`libGLESv2_emulation.so`). |
| **Sensors** | `Goldfish` sensor names (`Goldfish 3-axis Accelerometer`, etc.) and zero-variance static samples | Hardcoded in the vendor sensor HAL and QEMU virtual sensor backend. |
| **DRM & Media** | Widevine `securityLevel` = **L3**; `c2.goldfish.*` decoder names | Widevine **L1** requires hardware-backed TrustZone/TEE keys provisioned at the factory. |
| **Key Attestation & Play Integrity** | Software-backed `AndroidKeyStore` (`SECURITY_LEVEL_SOFTWARE`) | Hardware-backed attestation and Play Integrity `DEVICE_INTEGRITY` / `STRONG_INTEGRITY` require an OEM-signed hardware KeyMint/StrongBox keybox. |
| **Input & Virtual Hardware** | `virtio_input_multi_touch_*` input devices; missing `android.hardware.nfc`; `battery.voltage = 5000 mV` | Kernel evdev names from QEMU virtio-input, absent NFC HAL, and QEMU `goldfish_battery` hardcoded 5000 mV (`BatteryService` ignores `dumpsys battery set voltage`; `level`, `status`, `plugged`, and `temp` are overridden). |
| **Virtual Network** | QEMU slirp NAT (`10.0.2.x`, DNS `10.0.2.3`), virtual Wi-Fi RSSI `-50`, restricted `NetworkInterface` enumeration on API 34 | Provided by QEMU user-mode networking and `virtio-wifi` (`mac80211_hwsim`). |
| **System Packages** | `com.android.emulator.radio.config`, `com.google.android.connectivity.resources.goldfish.overlay` | Read-only system packages required for emulator radio and Wi-Fi connectivity (`com.android.emulator.multidisplay` is uninstalled for user 0). |
| **ADB Debugging** | `Settings.Global.ADB_ENABLED = 1` | Intentionally left enabled so PhoneDock can drive the device over ADB. |
| **Root (Magisk)** | `/debug_ramdisk/su`, `/debug_ramdisk/.magisk`, `magisk` tmpfs mounts | Required at boot for pre-zygote `resetprop`; opt-in `teardownMagisk` reduces but does not guarantee elimination of root detectability. |
| **Cellular / Modem (v1)** | `vport9p1` not attached (`SIM absent`, `OUT_OF_SERVICE`, empty `TelephonyManager` operator names) | Known Magisk ramdisk patch interaction with the emulator's virtual modem port (Wi-Fi and Play Store work normally; see *Telephony* above). |

---

## Legal, Terms of Service, and acceptable use

PhoneDock's virtual-phone disguise capability is built for **QA testing, device-compatibility verification, automation, and personal research** on Android apps that otherwise refuse to run or degrade functionality on stock Android Studio emulators.

- You are responsible for complying with applicable laws and the Terms of Service of any third-party app, platform, or service you interact with from a virtual phone.
- Do not use this feature for fraud, account-creation abuse, credential stuffing, ad/click fraud, bypassing payment/DRM protections, or evading platform bans.
- PhoneDock intentionally does **not** attempt to forge cryptographic hardware attestation, Play Integrity verdicts, or Widevine L1 DRM keys.
