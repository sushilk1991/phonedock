# Real iPhones (USB or Wi-Fi)

iPhone support is **Beta**. How PhoneDock connects depends on the iOS version:

| iOS | How | You need |
|---|---|---|
| **27 and later** | Directly, with no app on the phone | Developer Mode, one pairing, UI Automation turned on |
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

The first time you connect, PhoneDock mounts Apple's developer disk image on the phone if it's missing. That needs
an internet connection. Phones already used with Xcode usually have it.

For long sessions, set Settings › Display & Brightness › Auto-Lock to **Never**. Taps and typing need an unlocked
phone.

### Connect

Open PhoneDock and choose **Connect a Phone…**. Paired iPhones are listed under Nearby iPhones; they also appear
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
| `ios_too_old` | iOS 26 or older: use WebDriverAgent, below |
| `ddi_missing` | The developer disk image couldn't be mounted (it needs internet). Open the phone in Xcode once |
| `stream_busy` | Another app is showing the phone's screen, or a call, the camera, the microphone or Siri is active |
| `device_locked` | The phone is locked, so taps, swipes and typing weren't sent (they'd land on the Lock Screen). Unlock it; an agent should ask with `request_human`. Keys such as Home still work |
| `locked` | Unlock the phone |
| `local_network_denied` | Allow PhoneDock in System Settings › Privacy & Security › **Local Network** |

## iOS 26 and older: WebDriverAgent

Older iPhones need [WebDriverAgent](https://github.com/appium/WebDriverAgent) (WDA) running on the phone. It's a
test runner that PhoneDock builds and installs for you. WDA handles the screen, the UI tree, input, and launching
apps. Xcode's `devicectl` handles installing apps and listing them.

### Set it up once (needs a cable)

1. Plug the iPhone in by USB, unlock it and tap **Trust This Computer**.
2. In Xcode › Window › **Devices and Simulators**, select the phone and tick **Connect via network**.
3. On the iPhone, open Settings › Privacy & Security › **Developer Mode** and turn it on. The phone restarts.
4. Add your Apple ID in Xcode › Settings › Accounts and note its **Team ID** (10 characters). A free Apple ID
   works.
5. Find the phone's UDID with `phonedock devices --backend ios-device` (or `xcrun devicectl list devices`).
6. Build and start WebDriverAgent. Once step 2 is done, this also works over Wi-Fi:

   ```sh
   phonedock ios wda-setup --udid <UDID> --team <TEAMID> --name "My iPhone"
   ```

   The first run downloads and builds WebDriverAgent, which takes a few minutes.
   - If the iPhone says "Untrusted Developer", open Settings › General › **VPN & Device Management**, trust your
     certificate and run the command again.
   - When it's ready, the phone appears in PhoneDock with full controls.
   - Keep PhoneDock running; it keeps WebDriverAgent alive.

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
- With a free Apple ID, WebDriverAgent stops working after **7 days**. Run `phonedock ios wda-setup` again.
- After the iPhone restarts, or if PhoneDock stops, run `wda-setup` again to relaunch WebDriverAgent.
- The phone and the Mac must be on the same network. Keep the phone unlocked; Auto-Lock › Never helps.
- Back is an edge swipe.
- The live screen is a series of screenshots, so it updates about once a second rather than at full frame rate.
  (On iOS 27 and later it's video.)
