# Real iPhones (USB or Wi-Fi)

How PhoneDock connects depends on the iOS version. iOS 27 and later is supported; the WebDriverAgent path for iOS 26
and older is **Beta**.

| iOS | How | You need |
|---|---|---|
| **27 and later** | Directly, with no app on the phone | Developer Mode, one pairing, UI Automation turned on (PhoneDock downloads iPhone control automatically on first use) |
| 26 and older | Through WebDriverAgent, a test runner PhoneDock builds, installs and keeps running | Developer Mode, a USB cable once, an Apple ID in Xcode, one button |

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

Not available on a real iPhone:

- **Appearance (light or dark).** Use Settings › Display & Brightness on the phone.
- **Rotation.** iOS only lets the phone rotate when you turn it, and only if Portrait Orientation Lock is off.
  Apple's orientation command works on simulators only.
- **Logs.**
- **The foreground app.** Reading which app is in front needs WebDriverAgent. `phonedock ui` shows what's on screen
  instead.

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
| `ios_too_old` | iOS 26 or older: set up control once, below |
| `not_supported` "PhoneDock is setting up iPhone control (n%)" | Wait for the automatic setup to finish (check `phonedock components` or Settings › Advanced › Components) |
| `not_supported` "Couldn’t set up iPhone control" / "can’t control this iPhone yet" | Check your internet connection and retry with `phonedock components install ios-tools` (or Settings › Advanced › Components), or use the manual fallback in step 4 above |
| `ddi_missing` | The developer disk image couldn't be mounted (it needs internet). Open the phone in Xcode once |
| `stream_busy` | Another app is showing the phone's screen, or a call, the camera, the microphone or Siri is active |
| `device_locked` | The phone is locked, so taps, swipes and typing weren't sent (they'd land on the Lock Screen). Unlock it; an agent should ask with `request_human`. Keys such as Home still work |
| `locked` | Unlock the phone |
| `local_network_denied` | Allow PhoneDock in System Settings › Privacy & Security › **Local Network** |

## iOS 26 and older: WebDriverAgent

Older iPhones take taps, typing and the UI tree through [WebDriverAgent](https://github.com/appium/WebDriverAgent)
(WDA), a test runner on the phone. PhoneDock ships a pinned copy of its source, builds it once for your signing team,
puts it on the phone and keeps it running. Xcode's `devicectl` handles screenshots, installing and listing apps, crash
logs and the rest, with or without WDA.

### What you do (once)

1. **Turn on Developer Mode** on the iPhone: Settings › Privacy & Security › **Developer Mode**. It restarts.
2. **Trust this Mac:** plug the iPhone in by USB, unlock it and tap **Trust**.
3. **Sign in to Xcode:** Xcode › Settings › **Accounts** › add your Apple ID. A free Apple ID works.
4. **Set up control:** select the iPhone in PhoneDock and press **Set Up Control** (in its Info tab, or under
   ＋ Add Device › Physical Device › Older iPhone?). From a terminal:

   ```sh
   phonedock ios wda-setup --udid <UDID>    # the UDID is in `phonedock devices --backend ios-device`
   ```

   If Xcode is signed in to several teams, PhoneDock asks which one signs it (`phonedock ios wda-teams` lists them;
   pass `--team <TEAMID>`). The first setup downloads the pinned WebDriverAgent source (under 1 MB, SHA-256 checked),
   builds it (a few minutes) and starts it. Keep the iPhone unlocked meanwhile.

That's all. If the phone says **Untrusted Developer** (personal teams), open Settings › General › **VPN & Device
Management**, tap your Apple ID and tap **Trust**, then press **Retry** in PhoneDock (or run the setup again).

### What PhoneDock does

- **Checks first**, with plain errors before any build: Xcode installed, an Apple ID in Xcode (or an API key), the
  phone connected and trusted, Developer Mode on, the phone unlocked, and its iOS new enough for your Xcode (Xcode 27
  runs WebDriverAgent on iOS 17 and later).
- **Builds once** per WebDriverAgent version, team and Xcode build, and registers the phone with your team on the way
  (`-allowProvisioningDeviceRegistration`). It rebuilds by itself only when one of those changes, when the signing is
  about to expire (a free Apple ID signs for 7 days), or for a phone that isn't in the build's profile yet.
- **Keeps it private.** WebDriverAgent has no password: anyone who can reach it can control the phone. So PhoneDock
  makes it listen only on the phone's end of this Mac's paired developer connection (the CoreDevice tunnel Xcode uses,
  over USB or Wi-Fi). Other computers on your network, other Macs included, can't reach it. After each start PhoneDock
  checks that the phone's Wi-Fi address refuses it, and stops it if it doesn't.
- **Keeps it running.** WebDriverAgent stops whenever the iPhone restarts or PhoneDock restarts (including after an
  update). PhoneDock starts it again when it starts, when the phone reconnects over USB or Wi-Fi, and when it stops
  answering, with growing pauses between tries. A locked phone (one that just restarted, for example) waits until you
  unlock it; the device's Info tab says what PhoneDock is waiting for. If it still can't start after several tries it
  stops trying and says why; reconnect the phone or press Set Up Control again to start over. Setting up again keeps
  the running WebDriverAgent until the new build is ready.
- **Stop Control** (in the phone's Info tab or its right-click menu, or `phonedock ios wda-stop --udid <UDID>`) ends
  WebDriverAgent on the Mac and on the phone, and stops keeping it running. It doesn't unpair anything: the phone stays
  listed, and screenshots, apps and installs keep working. Set Up Control starts it again in seconds, with the same
  build. (Apple's **Unpair** in Finder or Xcode is something else: it removes the phone's trust in this Mac.)
  `phonedock disconnect ios-device:<UDID>` also stops it, and forgets the phone's saved settings.

### No Apple ID in Xcode? Use an App Store Connect API key

With a paid developer membership, an API key (App Store Connect › Users and Access › Integrations) can sign instead:

```sh
phonedock ios wda-setup --udid <UDID> --team <TEAMID> \
  --api-key-path ~/Downloads/AuthKey_<KEYID>.p8 --api-key-id <KEYID> --api-key-issuer <ISSUER-ID>
```

PhoneDock stores the key's path and IDs (not the key) so it can rebuild later.

### A second Mac

Only the Mac the iPhone is plugged into (or paired with) can set it up, and by default only that Mac can use it. To
drive the phone from another Mac on the same Wi-Fi, turn on **Let other Macs on this Wi-Fi control this iPhone** in
its Info tab (or set it up with `--share`; `--no-share` turns it off). **Anyone on that Wi-Fi can then control the
iPhone, without a password**, so use it on networks you trust. The Info tab then shows the address to use; on the other
Mac:

```sh
phonedock connect --ios Old-iPhone.local --name "Wi-Fi iPhone"     # the phone's local name, as shown; or its IP
phonedock connect --ios http://<iphone-ip>:8100 --udid <UDID>       # with the UDID, installing apps works too
```

In the app: ＋ Add Device › Physical Device › Older iPhone? › Set up on another Mac?. If Terminal reaches the phone
(`curl http://<iphone-ip>:8100/status`) but PhoneDock can't (`wda_unreachable`), macOS is blocking PhoneDock from the
network: allow it in System Settings › Privacy & Security › **Local Network**. If a different iPhone answers at that
address later (the network gave it the old one's address), PhoneDock shows the connection offline instead of sending
it your taps; connect again if that's intended.

Agents use the MCP tools `discover_devices` and `connect_device`. The HTTP routes are in [API.md](API.md).

### Errors

| Code | What to do |
|---|---|
| `xcode_account_missing` | Add your Apple ID in Xcode › Settings › Accounts, or use an API key (above) |
| `team_required` | Pick a team in PhoneDock, or pass `--team` (`phonedock ios wda-teams`) |
| `developer_mode_off` | Settings › Privacy & Security › Developer Mode, then restart the phone |
| `not_paired`, `not_found` | Plug the phone in, unlock it and tap Trust |
| `device_locked` | Unlock the phone. If the Info tab shows PhoneDock waiting, it carries on by itself; otherwise press Try Again |
| `wda_untrusted` | Settings › General › VPN & Device Management › your Apple ID › Trust, then Retry |
| `signature_invalid` | The phone refused the signature: set up control again (PhoneDock rebuilds an older build by itself) |
| `wda_exposed` | WebDriverAgent answered on the phone's Wi-Fi address while it shouldn't; PhoneDock stopped it. Set up again; report it if it repeats |
| `busy` | Another setup for this phone, or another PhoneDock on this Mac, runs it. Wait, or stop it there |
| `ios_unsupported` | The phone's iOS is older than this Xcode can test (iOS 17 for Xcode 27) |
| `bundle_id_unavailable`, `signing_limit` | Apple refused the team (a free Apple ID's limits, say). PhoneDock doesn't retry on its own (24 h for a quota): try later or use another team |
| `wda_unreachable` | Same Wi-Fi, and PhoneDock allowed under Privacy & Security › Local Network |
| `wda_not_ready` | PhoneDock is still starting WebDriverAgent, or waiting for what the message says |

### Limits

- Apple requires one USB pairing and a signing team. Before iOS 27 there's no way to do the first pairing without a
  cable.
- Signing a personal (free) team's build is not yet verified on hardware; paid teams are.
- The phone and the Mac must be on the same network for Wi-Fi. Keep the phone unlocked; Auto-Lock › Never helps.
- The private mode relies on the phone's developer connection (the CoreDevice tunnel). If macOS takes it down and
  brings it back with a new address, PhoneDock starts WebDriverAgent again on the new one.
- Back is an edge swipe.
- The live screen is a series of screenshots, so it updates about once a second rather than at full frame rate.
  (On iOS 27 and later it's video.)
- WebDriverAgent is © Facebook and contributors, BSD licence ([tools/licenses/WebDriverAgent-LICENSE](../tools/licenses/WebDriverAgent-LICENSE)).
