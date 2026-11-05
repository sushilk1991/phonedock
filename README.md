<div align="center">

<img src="docs/media/readme/icon.png" width="112" height="112" alt="PhoneDock app icon: a bright phone in front of a dimmed one">

# PhoneDock

**Your agent, on a real phone.**

A free, open-source Mac app that lets Claude Code, Codex, Cursor and Pi use your iPhone, your Android phone,
iOS simulators and Android emulators. You watch every step live, and the agent asks you when it needs your face or your password.

[![Latest release](https://img.shields.io/github/v/release/sushilk1991/phonedock?style=flat-square&label=release&color=6a5cf5)](https://github.com/sushilk1991/phonedock/releases/latest)
[![macOS 15 or later on Apple silicon](https://img.shields.io/badge/macOS_15+-Apple_silicon-1f1f24?style=flat-square&logo=apple)](#requirements)
[![Works with Claude Code, Codex, Cursor and Pi](https://img.shields.io/badge/MCP-Claude_Code_%C2%B7_Codex_%C2%B7_Cursor_%C2%B7_Pi-1f1f24?style=flat-square)](#for-agents)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-1f1f24?style=flat-square)](LICENSE)

[**Download for Mac**](https://github.com/sushilk1991/phonedock/releases/latest) &nbsp;·&nbsp;
[Website](https://sushilk1991.github.io/phonedock/) &nbsp;·&nbsp;
[Watch the 47-second video](https://sushilk1991.github.io/phonedock/#film)

</div>

<br>

<a href="https://sushilk1991.github.io/phonedock/#film"><img src="docs/media/launch/1-hero.png" alt="Your agent, on a real phone: the PhoneDock window while Claude Code tests the game Snackdoku on a real iPhone, with every step it takes in the Activity list"></a>

## See it work

Real recordings at real speed, with the waits trimmed. Nobody touches the phones.

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/media/readme/iphone-snackdoku.gif" width="300" alt="Screen recording on a real iPhone: Claude Code opens Snackdoku and goes through Daily Bake, the Bakery, Settings, How to Play and Recipe Road, then drags a cookie onto the board">
    </td>
    <td width="50%" align="center">
      <img src="docs/media/readme/android-play-store.gif" width="300" alt="Screen recording on a real Android phone: Claude Code opens Duolingo in the Play Store, goes to its reviews and sorts them by rating">
    </td>
  </tr>
  <tr>
    <td align="center"><b>Testing an app on a real iPhone</b><br><sub>Claude Code goes through Snackdoku screen by screen, drags a cookie onto the board and writes a QA report.</sub></td>
    <td align="center"><b>Research on a real Android phone</b><br><sub>Claude Code opens Duolingo in the Play Store and sorts its reviews by rating.</sub></td>
  </tr>
</table>

## Everything your agent needs on a phone

<img src="docs/media/launch/2-bento.png" alt="What PhoneDock does: live video at 60 fps, the agent's request for help, real iPhones and Android phones next to simulators and emulators, the Activity list, flows saved as tests, free and open source">

- **Watch live** at up to 60 fps while an agent works, in the app or in a separate window.
- **Real phones and virtual ones.** iPhones on iOS 27 or later connect over USB or Wi-Fi with nothing installed on
  the phone. Android phones connect over USB or Wi-Fi. Create Android emulators and iOS simulators from real system
  images, with snapshots and clones.
- **Every step in the Activity list.** Each tap, swipe and screenshot, who did it and when.
- **Take over and hand back** at any time. While you hold a device, agents wait.
- **Inspect** the UI tree, logs (coloured by level, for one app or all), crashes and installed apps. Switch dark mode,
  text size and contrast to check a layout.
- **Record** the screen to an `.mp4`, or save a screenshot. What you capture in the app goes where macOS saves your
  own screenshots. Recordings an agent starts stay in PhoneDock's data folder, and the agent is told the path.

## Put your agent to work

<img src="docs/media/launch/3-uses.png" alt="Put your agent to work: replying to Instagram comments on an Android phone, testing Snackdoku on an iPhone, and research in Google and the Play Store on Android">

- **Run your social accounts.** Reply to comments and go through the feed in the real apps.
- **Test your apps.** Go through a build screen by screen, attach screenshots to the PR, and save the run as a test.
- **Research in apps that have no website or API.** Read and sort reviews in the Play Store, or look things up in
  any app on the phone.

## It asks when it needs you

<img src="docs/media/launch/4-handoff.png" alt="It asks when it needs you: Claude Code's request in PhoneDock, asking you to sign in, with Take Over, Can't Do It and Done">

Some steps stay yours: Face ID, passwords, sign-ins, CAPTCHAs and payments. The agent stops and asks. If you're in
another app, a notification asks you. Click **Take Over**, do the step, click **Done**, and the agent carries on from
where it stopped. **Can't Do It** tells it why, so it can change course.

## Quick start

You need Xcode for iPhone simulators, or the Android SDK for Android emulators ([requirements](#requirements)).
PhoneDock shows what's ready and what's missing, with the command that fixes it.

1. **Install.** Download `PhoneDock-<version>.dmg` from the
   [latest release](https://github.com/sushilk1991/phonedock/releases/latest) and drag PhoneDock to Applications.
   It's signed and notarized by Apple.
2. **Connect your agent.** Open PhoneDock, click **Connect an Agent…**, then **Set Up** next to Claude Code, Codex,
   Cursor or Pi. Or run it in Terminal:

   ```sh
   /Applications/PhoneDock.app/Contents/Resources/bin/phonedock setup
   ```

3. **Ask your agent.** Start a new session and try:

   > Use PhoneDock to create an iPhone simulator, open Settings and turn on Dark Mode.

<details>
<summary><b>What <code>phonedock setup</code> changes</b></summary>
<br>

For every client it finds, setup registers PhoneDock's MCP server (user scope, so it works in every project),
installs the `phonedock` agent skill and links `phonedock` into a folder on your PATH (if none can take a link, it
gives you the line for your shell profile; agents use the full path, so they work either way). Then it checks each
step and tells you what to fix if one fails.

It never replaces settings it didn't write: it reports them instead, and it backs up every file it changes.
`--dry-run` shows the exact changes first; `--uninstall` takes them out again.

</details>

## Supported devices

| Device | Status | Notes |
|---|---|---|
| iPhone on iOS 27 or later | ✅ | USB or Wi-Fi with no app on the phone: live video, input and UI tree. [Setup](docs/IPHONE-WIFI.md) |
| Android phone | ✅ | USB, or Wi-Fi with wireless debugging |
| iOS simulator | ✅ | Simulator-built apps only |
| Android emulator | ✅ | Android SDK emulator, Google APIs and Play Store images |
| iPhone on iOS 26 or earlier | **Beta** | Needs WebDriverAgent on the phone. [Setup](docs/IPHONE-WIFI.md#ios-26-and-older-webdriveragent) |

Generic OS images (QEMU) and Corellium cloud devices are experimental; see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#experimental-backends).

<details>
<summary><b>Connect an Android phone over Wi-Fi</b></summary>
<br>

1. On the phone, turn on Settings › Developer options › Wireless debugging, then tap **Pair device with pairing code**
   and keep that screen open.
2. In PhoneDock choose **Connect a Phone › Android**. Your phone appears in the list (or run
   `phonedock discover --android`). If it doesn't, **Use a QR code instead** shows a code to scan from the phone's
   Pair device with QR code, and **Enter an address** takes the IP address and port the phone shows.
3. Type the six-digit code next to the phone and click **Pair**, or run `phonedock pair 123456`.
4. That's it: PhoneDock connects and the phone shows up in the sidebar. Next time, if the phone is already paired,
   click **Connect** (or run `phonedock connect`).

If macOS blocks it, PhoneDock says why. Either turn on PhoneDock in System Settings › Privacy & Security ›
Local Network, or click **Restart adb and Try Again** (CLI: `--restart-adb`; it briefly disconnects other tools that
use adb, such as Android Studio).

</details>

<details>
<summary><b>Connect an iPhone</b></summary>
<br>

iPhones on iOS 27 or later need Developer Mode, pairing with your Mac and UI Automation turned on. Nothing gets
installed on the phone, and USB or Wi-Fi both work. The steps are in [docs/IPHONE-WIFI.md](docs/IPHONE-WIFI.md).

</details>

## For agents

| Use | How |
|---|---|
| **MCP** | `phonedock mcp` (stdio) or `phonedock mcp --http <port>`. `phonedock setup` registers it with Claude Code, Codex, Cursor and Pi. Manual setup for other clients, the tool list and the recommended agent loop are in [docs/AGENTS-GUIDE.md](docs/AGENTS-GUIDE.md). |
| **Skill** | [skills/phonedock](skills/phonedock/SKILL.md) teaches an agent the fast loop (read the screen, act by text, check), when to take a screenshot, batching, handoffs and leases, plus recipes for PR evidence, crashes and App Store screenshots. `phonedock setup` installs it in `~/.claude/skills` and `~/.agents/skills`. |
| **CLI** | `phonedock` lives inside the app at `PhoneDock.app/Contents/Resources/bin/phonedock`; `phonedock setup` links it onto your PATH when it can. |
| **SDKs** | TypeScript ([src/sdk](src/sdk/index.ts)) and Python ([sdk/python](sdk/python/README.md)). The HTTP API is in [docs/API.md](docs/API.md). |

```sh
phonedock create --backend android-emulator --name Pixel --profile pixel_9 --boot
phonedock ui Pixel                    # accessibility outline with refs: e12 Button "Settings" @(540,1210)
phonedock tap Pixel --text "Settings"
phonedock screenshot Pixel -o shot.png
```

## From exploration to regression test

Ask your agent to test a flow once, save it, and run it on every PR.

1. The agent does the task on a device ("open the sample app, greet Ada, turn notifications on") and then calls
   `save_flow`, or you run `phonedock flow save <device> -o flows/greet.yaml` afterwards. PhoneDock turns what it did
   into a readable file. Text taps become text selectors and fills stay one step. Retries, timed-out waits and undone
   taps are left out, and checks are added for the first screen and the last:

   ```yaml
   name: Greet Ada and turn on notifications
   appId: dev.phonedock.sample
   platform: android
   minOS: "16"
   steps:
     - launch: dev.phonedock.sample
     - assert_visible: PhoneDock Sample
     - fill: { field: Your name, value: Ada }
     - tap: Greet
     - wait_for: { visible: "Hello, Ada!" }
     - tap: { text: Notifications, type: Switch }
     - assert_visible: Notifications on
   ```

2. `phonedock test flows/ --device <id> --junit junit.xml` replays it: PASS/FAIL per step with timings. It waits for
   each element and lets the screen settle between steps. Exit code 0 only if everything passed. A failure says
   what was expected and what was on screen, and saves a screenshot, the UI tree and recent logs.
3. Run the same command in CI on a macOS runner: [docs/CI.md](docs/CI.md). `phonedock flow export --maestro` writes a
   Maestro version of a flow. The format, the conversion rules and the runner are in [docs/API.md](docs/API.md#flows).

## Requirements

- A Mac with Apple silicon (M1 or later) on macOS 15 or later.
- **iOS simulators:** Xcode, plus [AXe](https://github.com/cameroncooke/AXe) for input and the UI tree
  (`brew install cameroncooke/axe/axe`).
- **Android:** the Android SDK command-line tools and emulator (`brew install --cask android-commandlinetools`).
  `scrcpy` and `ffmpeg` are optional (separate windows, recording, live streaming).
- **iPhones:** Xcode and `pymobiledevice3` (`uv tool install pymobiledevice3`).
- **Node.js:** PhoneDock.app includes its own runtime. Running from source needs Node.js 24 or later.

`phonedock backends` shows what's available on your Mac and what's missing.

## Privacy and security

- The PhoneDock service listens on `127.0.0.1` only. Every request needs a token that's stored in your user
  account's PhoneDock data folder (`~/Library/Application Support/PhoneDock`).
- macOS may ask for **Local Network** access when PhoneDock connects to a phone over Wi-Fi; that's what lets it
  reach phones on your network. Simulators, emulators and USB phones don't need it.
- There's no telemetry. PhoneDock goes online only for things you ask for: downloading system images or
  WebDriverAgent, mounting an iPhone's developer disk image, or a cloud backend you configure.
- Your agent's model provider sees the screenshots the agent sends it, the same as anything else in its context.
- Leases keep agents from colliding: while one agent or you hold a device, input from anyone else is refused. An
  agent's lease ends when its session ends, when its process exits, or after 10 minutes unused; yours lasts until
  you hand the device back.

## Limitations

- App Store apps can't run in the iOS simulator; use a real iPhone for those.
- On a real iPhone, only one app can show the phone's screen at a time, so close Xcode's device window or iPhone
  Mirroring first. iOS doesn't let PhoneDock switch light/dark mode, rotate the phone, read app logs or tell which app
  is in front ([details](docs/IPHONE-WIFI.md)).
- iPhones on iOS 26 or earlier are Beta: WebDriverAgent must be rebuilt every 7 days with a free Apple ID.
- Restarting the PhoneDock service clears leases. Devices keep running.
- On Android, PhoneDock reads the screen's elements through UiAutomation, which allows one client at a time. While
  you run your own UiAutomator or Espresso tests on the same device, set `PHONEDOCK_ANDROID_HELPER=0`.

## Build from source

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Free to use, change and share.
