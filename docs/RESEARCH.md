# Virtual & real phones on macOS: feasibility research

Status as of 2026-11 on an Apple Silicon Mac running macOS 27. PhoneDock wraps every option below as a
`Backend` (see `src/core/types.ts`). **WORKS** means verified on a test Mac. **BETA** means it works on real
hardware but still has rough edges. **EXPERIMENTAL** means implemented but unverified, or dependent on fragile or
third-party pieces. **NOT POSSIBLE** comes with the alternative architecture.

## Not possible today

- **Real iOS as a local VM that runs App Store apps.** Apple doesn't allow it. Locally there's CoreSimulator (real
  iOS frameworks, simulator-built apps only). For App Store binaries use a real iPhone or Corellium.
- **Cuttlefish on macOS.** It needs Linux with KVM. The way there is a Linux VM with nested virtualization, or a
  remote Cuttlefish host (see below). Designed, not implemented.

## Feasibility matrix

| Option | What runs | Accel on Apple Silicon | Status in PhoneDock |
|---|---|---|---|
| Android Emulator (QEMU fork) | Real AOSP / Google APIs / Play Store system images, ARM64 apps natively | Hypervisor.framework (HVF) | **WORKS** (`android-emulator`) |
| Cuttlefish (AOSP reference VM) | Real AOSP builds, multi-device, WebRTC display | Needs Linux + KVM | **NOT POSSIBLE natively**, design only |
| Upstream QEMU | Any OS image: Alpine/Debian/Ubuntu, postmarketOS, custom builds | HVF for aarch64 guests, TCG for x86_64 | **WORKS** (`qemu`, verified with Alpine aarch64) |
| iOS Simulator (CoreSimulator) | Real iOS userland frameworks, **simulator-built** apps only | Native (simulator processes run on macOS) | **WORKS** (`ios-simulator`) |
| Real iOS VM: Corellium | Real iOS/iPadOS and Android firmware on Arm servers (cloud or on-prem) | Corellium hypervisor | **EXPERIMENTAL** (`corellium`, REST client, untested without an account) |
| Real iOS VM: Apple PCC VRE / vphone-cli | Apple's Private Cloud Compute research VM; community tool boots patched iOS | Virtualization.framework | **EXPERIMENTAL / research-only**, not integrated |
| Real iOS in QEMU (xnu-qemu-arm64) | iOS 12 kernel to a bash shell, no UI | TCG | **NOT POSSIBLE** for apps or UI |
| Physical Android | Any device over USB/Wi-Fi debugging | n/a | **WORKS** (`android-device`: adb + scrcpy) |
| Physical iPhone | Any device paired with the Mac | n/a | **WORKS** on iOS 27+ (`ios-device`: Apple's CoreDevice services, no WebDriverAgent); **BETA** on older iOS (through WebDriverAgent) |
| Cloud device farms | Real devices or emulators behind an API | n/a | Corellium implemented; others listed below |

## Details

**Android Emulator.** This is Google's QEMU-based emulator (`emulator` 37 in the Android SDK). On Apple Silicon it
uses HVF with `arm64-v8a` system images, so ARM64 apps run at near-native speed. Image flavours:
`google_apis` lets `adb root` run, which gives root. `google_apis_playstore` has the Play Store and Google sign-in
but is a production build, so `adb root` is refused. Snapshots (`-snapshot`, console `avd snapshot save`) and
headless mode (`-no-window`) work. Docs: https://developer.android.com/studio/run/emulator-commandline

**Cuttlefish.** This is AOSP's cloud-oriented virtual device (`launch_cvd`, crosvm or QEMU). It needs Linux with KVM,
and there is no macOS host support. Alternative architecture (not implemented):
1. Run a Linux arm64 VM under Apple **Virtualization.framework** with nested virtualization
   (`VZGenericPlatformConfiguration.isNestedVirtualizationSupported`, Apple M3 or later, macOS 15+), so `/dev/kvm`
   exists in the guest. Then run Cuttlefish arm64 inside it and drive it via its WebRTC/ADB ports.
2. Or run a remote Linux/KVM Cuttlefish host (GCE, bare metal) and register it as a remote backend.
Cuttlefish adds no device type that the Android Emulator lacks for app testing; its value is AOSP platform work and
fleet scale. Docs: https://source.android.com/docs/devices/cuttlefish ·
https://developer.apple.com/documentation/virtualization/vzgenericplatformconfiguration

**Upstream QEMU (`qemu` backend).** Homebrew QEMU 11.1 with `-M virt -accel hvf -cpu host`, EDK2 UEFI, `virtio-gpu-pci`,
a USB tablet and keyboard, user-mode NAT, and QMP on a unix socket. The backend takes user ISOs or disks
(`options.isoPath` / `options.diskPath`, used as a linked-clone qcow2 backing file) or a catalog. Measured on a test
host with Alpine 3.24 `virt` aarch64 ISO, 2 vCPU / 1 GB:
- QMP ready plus first frame in **0.83 s**, login prompt in about **18 s**.
- `savevm` in **1.7–3.8 s** (about 203 MB), `loadvm` in **1.2–2.4 s**.
- Cold restore of a stopped VM via `-loadvm` in **1.6 s**; APFS clone in **14 ms**.
- Typing about **55 ms/char**.
- Mobile Linux: postmarketOS (now also branded "Nura", images.postmarketos.org) publishes **no prebuilt qemu-aarch64
  image**. You build one with `pmbootstrap` (device `qemu-aarch64`, UI phosh or plasma-mobile) and pass `diskPath`.
  The catalog offers the prebuilt `generic-x86_64` Phosh and Plasma Mobile images (about 1.7 GB), but they run under TCG
  emulation and are slow. Ubuntu Touch has no maintained generic QEMU arm64 image.
- Limits: no in-guest agent, so no `shell`, app install or UI tree. Use qemu-guest-agent or ssh via `hostfwd` as
  future work. Input is US-ASCII through QMP keyboard events.
Docs: https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html

**iOS Simulator.** CoreSimulator runs the real iOS frameworks as macOS processes (`xcrun simctl`, plus `axe` for
HID input and accessibility). It runs only apps built for the *simulator* SDK. App Store apps and device `.ipa`
files (arm64 `iphoneos`, FairPlay-encrypted) **cannot run**, and there is no App Store, Apple Pay, push to a real
APNs device token, camera or Bluetooth. Alternative: a physical iPhone or Corellium for App Store binaries.
Docs: https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device

**Real iOS virtualization.**
- *Corellium* (commercial, cloud or on-prem) is the only supported product that runs unmodified iOS firmware as a VM.
  It supports jailbroken and non-jailbroken modes, snapshots, touch/text input, screenshots, and an in-VM agent for apps and files.
  PhoneDock's backend uses REST v1 (`/v1/projects`, `/v1/models/{flavor}/software`, `POST /v1/instances`,
  `start/stop`, `/snapshots`, `/screenshot.png`, `/input`, `/agent/v1/app/*`, `/agent/v1/file/*`). Spec:
  https://app.corellium.com/api/openapi.json · https://support.corellium.com/api
- *Apple PCC Virtual Research Environment* (macOS 15.1+, `pccvre`) is an Apple-supported VM for researching
  Private Cloud Compute nodes (cloudOS). It has no SpringBoard, App Store or third-party apps.
  https://security.apple.com/documentation/private-cloud-compute/virtualresearchenvironment
- *vphone-cli* (community, https://github.com/Lakr233/vphone-cli) reuses the PCC VRE "vresearch" VM platform via
  Virtualization.framework to boot patched iPhone firmware with a visible UI. It needs a physical Apple Silicon Mac
  on macOS 15+ with debugging restrictions relaxed in Recovery. It is research-grade and unsupported by Apple, and
  firmware pairings break across releases. App Store/Apple ID use is not a supported path, so PhoneDock does not
  integrate it.
- *alephsecurity/xnu-qemu-arm64* (https://github.com/alephsecurity/xnu-qemu-arm64) boots an iOS 12 kernel to a bash
  shell in QEMU. It is for kernel research only: no display stack, no apps.
- **NOT POSSIBLE**: running App Store iOS apps in a local, Apple-sanctioned VM. Alternative architecture: a physical
  iPhone over USB/Wi-Fi, or Corellium or a hosted iPhone through the same Backend contract.

**Physical devices.** Android uses `adb` (always `-s <serial>`) plus scrcpy for low-latency mirroring and control.
iPhone uses `xcrun devicectl` (Xcode 15+) for install, launch and file transfer, and pymobiledevice3 for lockdown
services and syslog. On iOS 27 and later, screen capture, touch input and the UI tree come from the same on-device
services Xcode uses, so no app runs on the phone ([IPHONE-WIFI.md](IPHONE-WIFI.md)). Older iOS needs
WebDriverAgent/XCUITest for touch, screenshots and the UI tree, which needs a signing identity. Developer Mode
must be on.
https://github.com/Genymobile/scrcpy · https://github.com/appium/WebDriverAgent · https://github.com/doronz88/pymobiledevice3

**Cloud providers.**
- Corellium: real iOS/Android VMs.
- Phone Harness (https://github.com/phone-harness/mcp, MIT): a hosted MCP at `https://mcp.phone-harness.com/mcp`
  with dedicated cloud iPhones and Android emulators, OAuth or API key, also self-hostable.
- BrowserStack App Automate, AWS Device Farm and Sauce Labs: real-device farms via Appium/XCUITest. Remote-access
  sessions exist but are not VM-snapshot capable.
- Genymotion SaaS: Android VMs in AWS/GCP/Azure, adb over a tunnel.
All of these fit PhoneDock as `kind: 'cloud'` backends. Only Corellium is implemented.

## Reused OSS components (invoked as separate processes, no linking)

| Component | Use | License |
|---|---|---|
| QEMU | `qemu` backend; base of the Android Emulator | GPL-2.0 |
| EDK2 (OVMF/AAVMF firmware, Homebrew `share/qemu`) | UEFI for QEMU guests | BSD-2-Clause-Patent |
| Android Emulator / platform-tools (adb) | Android virtual + physical | Apache-2.0 (+ GPL for QEMU parts) |
| scrcpy | Android mirroring/control | Apache-2.0 |
| AXe | iOS Simulator HID + accessibility | MIT |
| WebDriverAgent (Appium fork) | iPhone input / UI tree on iOS 26 and older | BSD-3-Clause |
| pymobiledevice3 | iPhone lockdown services | GPL-3.0 |
| ffmpeg | frame conversion / streaming | LGPL-2.1+ (GPL build in Homebrew) |
| Alpine Linux, postmarketOS images | QEMU catalog images (downloaded, not shipped) | Various (GPL/MIT; pmaports GPL-3.0) |
| Cuttlefish (design only) | AOSP virtual device | Apache-2.0 |
| Corellium API | Cloud backend (REST, no SDK) | Proprietary service |

GPL tools are executed as separate programs over their CLI or socket interfaces, so PhoneDock (Apache-2.0) does not
link against them.
