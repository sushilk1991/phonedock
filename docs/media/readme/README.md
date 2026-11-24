# README media

| File | Origin |
|---|---|
| `icon.png` | The app icon, exported at 256x256 from the built app's `AppIcon.icns` |
| `iphone-snackdoku.gif` | `site/assets/snackdoku.mp4` as a GIF (360 px wide, 15 fps): 8 cuts of a 60 fps screen recording of Claude Code testing Snackdoku on a real iPhone through PhoneDock, at real speed with the waits trimmed. A notification during the drag is blurred. |
| `android-play-store.gif` | `site/assets/run-play.mp4` as a GIF (360 px wide, 15 fps): a screen recording on a real Android phone while Claude Code opened Duolingo in the Play Store and sorted its reviews, nobody touching the phone (from the privacy-cleaned copy). |

## README cards

Four 2400x1350 cards for the README, made for PhoneDock 0.6.0. Every screen in them is a capture of the real
PhoneDock window at 2880x1800, taken on 2026-11-24 on test devices: an iPhone 17 Pro simulator, an iPad Air
simulator and a Pixel 8 virtual phone. Their names were shortened in the window for the captures (the test service
needs a "Test" prefix). The layout and text are set in HTML by [`src/render.py`](src/render.py) and rendered with
headless Chrome; the frames it uses are in `src/frames`. Nothing is generated or mocked.

| File | What it shows |
|---|---|
| `hero.png` | "Your agent, on every phone." over the window while Claude Code runs a saved test on the iPhone simulator: Claude Code is in control, with Take Over one click away |
| `window.png` | "One window for every phone.": a Pixel 8 virtual phone running, an iPhone simulator and an iPad in the sidebar, and the phone's settings in the inspector |
| `runs.png` | "Every run, on the record.": the Runs tab's detail of that test run (PASS, the app's version and build, the flow's hash, the git commit, the device and the agent, and each step) |
| `setup.png` | "It sets itself up.": Settings › Advanced › Components with both tools ready, over the output of `phonedock components install ios-tools` (some progress lines left out) |

Re-render with `python3 src/render.py [hero|window|runs|setup]`.

The other large images are the launch images in [`../launch`](../launch/README.md).
