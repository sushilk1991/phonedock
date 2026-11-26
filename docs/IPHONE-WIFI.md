# Real iPhones (USB or Wi-Fi)

How PhoneDock connects depends on the iOS version. iOS 27 and later is supported; the WebDriverAgent path for iOS 26
and older is **Beta**.

| iOS | How | You need |
|---|---|---|
| **27 and later** | Directly, with no app on the phone | Developer Mode, one pairing, UI Automation turned on (PhoneDock downloads iPhone control automatically on first use) |
| 26 and older | Through WebDriverAgent, a test runner you install on the phone | Developer Mode, a USB cable once, an Apple ID for signing, a rebuild every 7 days |

## iOS 27 and later

PhoneDock uses the same services on the phone that Xcode does. Nothing is installed on the iPhone, and no signing
team is needed. It works over USB, or over Wi-Fi when the phone and the Mac are on the same network.

### Set it up once

1. **Turn on Developer Mode.** On the iPhone, open Settings › Privacy & Security › **Developer Mode**, turn it on
   and let the phone restart. If the switch is missing, connect the phone to Xcode once; that reveals it.
2. **Pair the phone with this Mac.** Use either method:
   - **USB:** plug the phone in, unlock it and tap **Trust**. After that it also works over Wi-Fi on the same
     network.
   - **Wi-Fi:** in Xcode › Window › **Devices and Simulators**, select the phone when it appears and pair it with
     the code it shows.
3. **Allow control.** On the iPhone, open Settings › **Developer** › **Enable UI Automation**. This is needed
   for taps and typing. Without it, PhoneDock can still show the screen and the UI tree.
4. **iPhone control installs automatically.** The first time PhoneDock sees a paired iOS 27+ iPhone, it downloads a
   pinned Python 3.12 runtime and `pymobiledevice3` (~277 MB on disk) in the background and verifies every file by
   SHA-256. That needs an internet connection the first time (and whenever a PhoneDock update bumps the pin). While it
   sets up, screenshots and app management already work, and the screen switches to live video automatically once setup
   finishes — no restart needed. You can also trigger or retry it in **Settings › Advanced › Components** or with
   `phonedock components install ios-tools`.
   - **Manual fallback:** If you prefer your own install or work offline, `uv tool install --python 3.12 pymobiledevice3`
     (or `pipx install --python python3.12 pymobiledevice3`, or setting `PHONEDOCK_PYMD3_PYTHON`) still works. Set
     `PHONEDOCK_COMPONENTS_AUTO=0` to disable automatic downloads.

The first time you connect, PhoneDock mounts Apple's developer disk image on the phone if it's missing. That needs
an internet connection. Phones already used with Xcode usually have it.

For long sessions, set Settings › Display & Brightness › Auto-Lock to **Never**. Taps and typing need an unlocked
phone.

### Connect

Open PhoneDock and choose **＋ Add Device › Physical Device** (or File › Connect a Physical Device…). Paired iPhones are listed under Nearby iPhones; they also appear
in the sidebar on their own. From a terminal:

```sh
phonedock devices --backend ios-device    # the phone should be listed as running
phonedock backends                        # shows what's missing if it isn't
```

### What works

Tested on an iPhone 16 Pro Max running iOS 27.0 over Wi-Fi, with no WebDriverAgent:

- A smooth live view in the PhoneDock app: the phone's own screen stream (the one Xcode uses), decoded in hardware,
  at up to 60 frames a second (measured scrolling Settings over Wi-Fi: 58 frames a second, 16 ms apart). It also
  shows the Lock Screen. Agents and other clients that take JPEG frames (`/frame`, `/stream`) get about 13 a second
  from the same stream, a median of 34 ms old.
- Screenshots, in 1 to 2 seconds each.
- The UI tree: labels, values and frames of what's on screen, so agents can tap by text. It's complete inside apps
  and only partial on the Home Screen.
- Tap (by text or by position), swipe, scroll to a label, and the Home and Back keys.
- Typing, including non-ASCII text such as "café", and filling a text field.
- Listing installed apps, launching an app (it comes to the front) and closing one.
- Opening a URL. It opens in the phone's **default** browser, which isn't always Safari.
- Screen recording from the same stream: HEVC at up to 60 frames a second, not re-encoded, with the right length.
- Listing crash reports, newest first, in your local time.

Not verified: installing an app. It needs an app signed for development, and none was available to test.

The clipboard (`phonedock clipboard <phone> --get` / `--set TEXT`, the MCP `clipboard` tool) goes through iOS 27's
pasteboard service. Over Wi-Fi the first call takes about 2 seconds; after that a set takes about 0.2 s and a read
about 0.1 s (verified on an unlocked phone: set, read back, restore). While the phone is locked iOS shares nothing,
so PhoneDock answers that the iPhone is locked (`device_locked`) instead of reporting an empty clipboard: unlock it
first.

Not available (or hardware-unvalidated) on a real iPhone:

- **Rotation.** iOS only lets the phone rotate when you turn it, and only if Portrait Orientation Lock is off.
  Apple's orientation command works on simulators only.
- **Appearance (light or dark), Logs, and Foreground app.** Not available on older iPhones without WebDriverAgent
  (use Settings › Display & Brightness on the phone, and `phonedock ui` to see what's on screen). On iOS 27,
  PhoneDock includes experimental native paths for these (`ios-device.ts`), though they have not yet been
  validated on iOS 27 hardware.

If something here fails on your phone, please open an issue on GitHub.

### Things to know

- **One screen viewer at a time.** iOS shares the phone's screen with one app at a time. PhoneDock's live view,
  recording and taps all use that one screen share. If Xcode's device window, iPhone Mirroring or another tool is
  showing the phone, close it first. Otherwise taps get `stream_busy`. The live view never takes the screen from
  another app: it shows screenshots instead, which can be very slow while the other app streams, and goes back to
  video by itself within about a minute of the other app closing.
- iOS stops sharing the screen **during a phone or FaceTime call, while the camera or microphone is in use, or
  while Siri is active**.
- While PhoneDock shows or drives the phone, iOS shows its screen-sharing indicator, and apps can't use the camera
  or microphone. PhoneDock ends the share about 5 seconds after you stop watching, and 45 seconds after the last
  tap or keystroke.
- The UI tree covers the app in front, plus system overlays such as the keyboard and banners. Some Home Screen
  widgets are drawn by another process and may be missing from it.

### Errors

| Code | What to do |
|---|---|
| `not_paired` | Pair once: plug in and tap **Trust**, or pair in Xcode › Devices and Simulators |
| `no_device` | The phone is paired but can't be reached. Wake and unlock it, check that it's on the same Wi-Fi, or plug it in |
| `developer_mode_off` | Settings › Privacy & Security › Developer Mode › On, then restart the phone |
| `ui_automation_off` | Settings › Developer › Enable UI Automation |
| `ios_too_old` | iOS 26 or older: use WebDriverAgent, below |
| `not_supported` "PhoneDock is setting up iPhone control (n%)" | Wait for the automatic setup to finish (check `phonedock components` or Settings › Advanced › Components) |
| `not_supported` "Couldn’t set up iPhone control" / "can’t control this iPhone yet" | Check your internet connection and retry with `phonedock components install ios-tools` (or Settings › Advanced › Components), or use the manual fallback in step 4 above |
| `ddi_missing` | The developer disk image couldn't be mounted (it needs internet). Open the phone in Xcode once |
| `stream_busy` | Another app is showing the phone's screen, or a call, the camera, the microphone or Siri is active |
| `device_locked` | The phone is locked, so taps, swipes and typing weren't sent (they'd land on the Lock Screen). Unlock it; an agent should ask with `request_human`. Keys such as Home still work |
| `locked` | Unlock the phone |
| `local_network_denied` | Allow PhoneDock in System Settings › Privacy & Security › **Local Network** |

## iOS 26 and older: WebDriverAgent

Older iPhones take taps, typing and the UI tree through [WebDriverAgent](https://github.com/appium/WebDriverAgent)
(WDA), a test runner on the phone. PhoneDock ships a pinned copy of its source (16.15.3, SHA-256 checked), builds it
once for your signing team and starts it when you press **Set Up Control**. Xcode's `devicectl` handles screenshots,
installing and listing apps, crash logs and the rest, with or without WDA.

### Set up control (needs a cable once)

1. **Turn on Developer Mode** on the iPhone: Settings › Privacy & Security › **Developer Mode**. It restarts.
2. **Trust this Mac:** plug the iPhone in by USB, unlock it and tap **Trust**. For Wi-Fi later, tick **Connect via
   network** for the phone in Xcode › Window › Devices and Simulators.
3. **Sign in to Xcode:** Xcode › Settings › **Accounts** › add your Apple ID. A free Apple ID works.
4. **Set up control:** select the iPhone in PhoneDock and press **Set Up Control** in its Info tab. From a terminal:

   ```sh
   phonedock ios wda-setup --udid <UDID>    # the UDID is in `phonedock devices --backend ios-device`
   ```

   With several teams in Xcode, PhoneDock asks which one signs it (`phonedock ios wda-teams` lists them; pass
   `--team <TEAMID>`), then remembers it. The first time it downloads the source (under 1 MB) and builds it, which takes
   a few minutes; after that, setting up takes about 8 seconds. Keep the iPhone unlocked meanwhile. If the phone says
   **Untrusted Developer** (personal teams), open Settings › General › **VPN & Device Management**, tap your Apple ID,
   tap **Trust**, and set up control again.

What it does, in order: plain checks first (Xcode, an Apple ID or API key, the phone connected, trusted, unlocked,
Developer Mode on, iOS new enough for your Xcode), then the build if there is none for this team and Xcode yet
(`build-for-testing`, registering the phone with the team), then the launch.

**Private by default.** WebDriverAgent has no password: anyone who can reach it can control the phone. So PhoneDock
starts it bound to the phone's end of this Mac's developer connection (the CoreDevice tunnel Xcode uses, over USB or
Wi-Fi), and checks that it answers there and that the phone's Wi-Fi address refuses it. If it can't confirm that, it
stops what it just started and says why (allow PhoneDock under Privacy & Security › Local Network if it keeps saying
so).

**What's already running is left alone.** If WebDriverAgent already runs on the phone and is provably private to
this Mac (it answers on this Mac's tunnel and the phone's Wi-Fi address refuses it), Set Up Control uses it. If one
runs that isn't, or can't be shown to be (another Mac's, Xcode's, a shared one, several at once, or a phone with no
Wi-Fi address to check), setup leaves it running and says so: **Stop Control** ends it, then Set Up Control starts PhoneDock's.

**Control doesn't come back by itself.** When the iPhone restarts, or PhoneDock restarts (an update, say), control
may stop: taps then say `wda_not_ready`. Press Set Up Control again (about 8 seconds); if WebDriverAgent is still
running and private, it is used as it is. A free Apple ID's signing lasts 7 days; after
that Set Up Control builds and signs it again.

**Stop Control** (the Info tab, the phone's right-click menu, or `phonedock ios wda-stop --udid <UDID>`) ends every
WebDriverAgent on the phone, whoever started it. The phone stays paired and listed; screenshots, apps and installs
keep working.

### Let another Mac control it

Turn on **Let other Macs on this Wi-Fi control this iPhone** when you set up control (or pass `--share`). That launch
listens on the phone's Wi-Fi address too, and the Info tab shows the address. **Anyone on that Wi-Fi can then control
the iPhone, without a password, until you press Stop Control or the iPhone restarts.** Sharing isn't a setting: to
turn it off, press Stop Control, then Set Up Control without it. About once a minute PhoneDock checks whether the
phone answers on its Wi-Fi address and says so in the app, under `phonedock devices` and in the MCP device list, also
after a restart or a setup from the CLI; when it can't check (Local Network permission), it says that, never
"private". While WebDriverAgent runs, setting up again (shared
or not) says it is already running; Stop Control first. On the other Mac:

```sh
phonedock connect --ios <iphone-ip> --name "Wi-Fi iPhone"
```

### No Apple ID in Xcode? Use an App Store Connect API key

With a paid developer membership, an API key (App Store Connect › Users and Access › Integrations) can sign instead:

```sh
phonedock ios wda-setup --udid <UDID> --team <TEAMID> \
  --api-key-path ~/Downloads/AuthKey_<KEYID>.p8 --api-key-id <KEYID> --api-key-issuer <ISSUER-ID>
```

PhoneDock doesn't remember the key: pass these options each time you set up control.

### Already running WebDriverAgent?

```sh
phonedock discover --ios                                      # look for iPhones on the network
phonedock connect --ios <iphone-ip> --name "Wi-Fi iPhone"     # connects to http://<iphone-ip>:8100
phonedock connect --ios http://<iphone-ip>:8100 --udid <UDID> # with the UDID, installing apps works too
phonedock disconnect ios-device:wda-<iphone-ip>-8100
```

Agents use the MCP tools `discover_devices` and `connect_device`. The HTTP routes are in [API.md](API.md).

### Limits

- Apple requires one USB pairing and a signing team. Before iOS 27 there's no way to do the first pairing without a
  cable.
- With a free Apple ID, the signing lasts **7 days**. Set Up Control signs it again.
- After the iPhone restarts, or PhoneDock restarts, press Set Up Control again: nothing relaunches WebDriverAgent by
  itself.
- Simulators: `phonedock ios wda-setup --udid <id> --destination 'platform=iOS Simulator,id=<id>'` works as before. A
  destination must name the same device as `--udid`.
- A WebDriverAgent repackaged under another app name isn't recognised as one: Stop Control doesn't see it.
- The private check asks the phone's Wi-Fi address from this Mac. If this Mac is on another network whose addresses
  overlap the phone's (the phone on USB), another device can answer for it.
- WebDriverAgent is © Facebook and contributors, BSD licence ([tools/licenses/WebDriverAgent-LICENSE](../tools/licenses/WebDriverAgent-LICENSE)).
- The phone and the Mac must be on the same network. Keep the phone unlocked; Auto-Lock › Never helps.
- Back is an edge swipe.
- The live screen is a series of screenshots, so it updates about once a second rather than at full frame rate.
  (On iOS 27 and later it's video.)
