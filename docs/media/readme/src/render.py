#!/usr/bin/env python3
"""Render the README's cards (2400x1350 PNG) from the frames in ./frames with headless Chrome.

Every screen in a card is a real capture of PhoneDock 0.6.0 (see ../README.md, "README cards"). Layout and text are set here.
Usage: python3 render.py [name ...]   (no names: all cards). Writes ../<name>.png.
"""
import html
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H = 2400, 1350

BASE_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 2400px; height: 1350px; overflow: hidden; }
body { font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
       -webkit-font-smoothing: antialiased; position: relative; }
body.dark { background: #000; color: #f5f5f7; }
body.light { background: #f4f4f6; color: #111114; }
.grad { background: linear-gradient(90deg, #6d5cf6 0%, #a47cff 100%); -webkit-background-clip: text;
        background-clip: text; color: transparent; }
h1 { font-weight: 700; letter-spacing: -0.045em; line-height: 1.02; }
.sub { font-weight: 400; letter-spacing: -0.01em; line-height: 1.3; }
.dark .sub { color: #a1a1aa; }
.light .sub { color: #5f5f66; }
.brand { display: flex; align-items: center; gap: 18px; font-size: 40px; font-weight: 600; letter-spacing: -0.02em; }
.brand img { width: 64px; height: 64px; }
.shot { position: absolute; overflow: hidden; border-radius: 28px; }
.dark .shot { border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 40px 140px rgba(110, 92, 246, 0.18); }
.light .shot { border: 1px solid rgba(0,0,0,0.10); box-shadow: 0 40px 120px rgba(20, 20, 40, 0.22); }
.shot img { position: absolute; display: block; }
.term { position: absolute; font-family: "JetBrains Mono", "SF Mono", Menlo, monospace; font-size: 28px;
        line-height: 1.6; color: #d4d4d8; background: #0d0d10; border: 1px solid rgba(255,255,255,0.10);
        border-radius: 24px; padding: 30px 38px; white-space: pre; }
.term .p { color: #a47cff; } .term .ok { color: #4ade80; } .term .dim { color: #71717a; }
"""


def shot(src, box, crop=None):
    """box = (left, top, width, height) on the card; crop = (x, y, w, h) in source pixels (default: whole frame).
    The crop is scaled to the box's width; the box clips anything below its height."""
    import struct
    left, top, bw, bh = box
    data = (HERE / "frames" / src).read_bytes()
    if src.endswith(".png"):
        sw, sh = struct.unpack(">II", data[16:24])
    else:  # JPEG: read the SOF0/SOF2 frame size
        i = 2
        while True:
            seg, ln = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
            if seg in (0xC0, 0xC2):
                sh, sw = int.from_bytes(data[i + 5:i + 7], "big"), int.from_bytes(data[i + 7:i + 9], "big")
                break
            i += 2 + ln
    cx, cy, cw, ch = crop or (0, 0, sw, sh)
    s = bw / cw
    return (f'<div class="shot" style="left:{left}px;top:{top}px;width:{bw}px;height:{bh}px">'
            f'<img src="frames/{src}" style="width:{sw * s:.1f}px;height:{sh * s:.1f}px;'
            f'left:{-cx * s:.1f}px;top:{-cy * s:.1f}px"></div>')


BRAND = '<div class="brand"><img src="frames/icon.png" alt="">PhoneDock</div>'


def card(theme, body):
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{BASE_CSS}</style></head><body class="{theme}">{body}</body></html>'


CARDS = {
    # The hero: Claude Code running a saved test on the iPhone simulator, in control, with Take Over one click away.
    "hero": card("light", f"""
      <div style="position:absolute;top:70px;left:0;right:0;display:flex;justify-content:center">{BRAND}</div>
      <h1 style="position:absolute;top:168px;left:0;right:0;text-align:center;font-size:132px">Your agent, on <span class="grad">every phone.</span></h1>
      <p class="sub" style="position:absolute;top:338px;left:0;right:0;text-align:center;font-size:40px">
        Claude Code, Codex, Cursor and Pi use your iPhone, your Android phone, simulators and virtual phones.<br>
        You watch every screen live, and take over any time.</p>
      {shot("agent-in-control.jpg", (320, 500, 1760, 900))}
    """),
    # One window: a virtual Pixel 8 next to an iPhone simulator and an iPad in the sidebar.
    "window": card("dark", f"""
      <h1 style="position:absolute;top:84px;left:96px;font-size:120px">One window for <span class="grad">every phone.</span></h1>
      <div style="position:absolute;top:104px;right:96px">{BRAND}</div>
      <p class="sub" style="position:absolute;top:240px;left:100px;font-size:40px">
        Simulators, emulators, virtual phones and your own phones, side by side. Live, with every setting a tap away.</p>
      {shot("virtual-pixel.jpg", (320, 370, 1760, 1100))}
    """),
    # Run records: the detail of a saved flow's run, with what it ran on.
    "runs": card("dark", f"""
      <div style="position:absolute;top:96px;left:96px">{BRAND}</div>
      <h1 style="position:absolute;top:300px;left:96px;width:700px;font-size:112px">Every run,<br><span class="grad">on the record.</span></h1>
      <p class="sub" style="position:absolute;top:580px;left:100px;width:620px;font-size:38px">
        Each test run is saved with the app's version and build, the flow's hash and the git commit it ran on.
        Copy a summary into your pull request.</p>
      {shot("run-detail.jpg", (820, 110, 1480, 1130), (640, 290, 1560, 1192))}
    """),
    # Components: PhoneDock installs its own iPhone and simulator tools.
    "setup": card("dark", f"""
      <div style="position:absolute;top:96px;left:96px">{BRAND}</div>
      <h1 style="position:absolute;top:300px;left:96px;width:720px;font-size:112px">It sets<br><span class="grad">itself up.</span></h1>
      <p class="sub" style="position:absolute;top:580px;left:100px;width:640px;font-size:38px">
        PhoneDock downloads, checks and updates the tools iPhones and simulators need. No Homebrew, no Python setup.</p>
      {shot("components-card.jpg", (860, 200, 1440, 507))}
      <div class="term" style="left:860px;top:780px;width:1440px"><span class="p">$</span> phonedock components install ios-tools
<span class="dim">  Downloading iPhone Control…</span>
<span class="dim">  Verifying checksum…</span>
<span class="dim">  Installing pymobiledevice3 11.63.1…</span>
<span class="dim">  Verifying iPhone helpers…</span>
Component ios-tools: <span class="ok">done</span></div>
    """),
}


def render(name):
    with tempfile.NamedTemporaryFile("w", suffix=".html", dir=HERE, delete=False) as f:
        f.write(CARDS[name])
        page = pathlib.Path(f.name)
    out = OUT / f"{name}.png"
    try:
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        f"--window-size={W},{H}", "--allow-file-access-from-files", f"--screenshot={out}",
                        page.as_uri()], check=True, capture_output=True, timeout=120)
    finally:
        page.unlink(missing_ok=True)
    print(out, out.stat().st_size)


if __name__ == "__main__":
    for n in sys.argv[1:] or CARDS:
        render(n)
