#!/usr/bin/env python3
"""pd-ios-hid: a persistent touch / keyboard / button channel to a real iPhone on iOS 27+.

Rides Apple's own CoreDevice tunnel (pymobiledevice3 NativeRemotedTunnel, which piggybacks `remoted`): no root, no
WebDriverAgent, works over Wi-Fi, and isn't blocked by macOS Local Network privacy for terminal-launched processes.
It keeps a display media stream open, because iOS only honours injected touches while a stream runs (dtuhidd's "auth
gate"). Opening costs ~1 s, so holding it makes each gesture cost milliseconds. The device reaps a stream that gets no
RTCP after ~20 s (streamConfig RTCPTimeoutInterval=20), and another client (Xcode Device Hub, iPhone Mirroring)
starting a stream replaces ours, so we send an RTCP Receiver Report every second, check RTP is still flowing before
each gesture and reopen when it isn't, and on close stop only OUR session (stop_all=False), never other clients'.
While a stream is open iOS treats the phone as "observed remotely" (camera/mic blocked): callers should close it
when idle.

Run with the pymobiledevice3 venv's python:  <venv>/bin/python -I -u tools/pd-ios-hid.py --udid <UDID>

Protocol, JSON lines. Coordinates are already normalised to the HID range 0..65535 by the caller.
  stdin   {"id": 1, "cmd": "tap", "x": 20352, "y": 53832}
  stdout  {"event": "ready", "ms": 1890}          once the stream is open
          {"id": 1, "ok": true, "ms": 60}
          {"id": 1, "ok": false, "error": "..."}
Commands: ping | status | ensure | tap {x,y} | hold {x,y,ms} | drag {x1,y1,x2,y2,ms} | double_tap {x,y} | type {text} | key {name} | combo {mods,key}
          | button {name} | quit
A connection-level failure exits the process (code 2); the PhoneDock backend respawns it on the next command.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import struct
import sys
import time

from pymobiledevice3.remote.core_device.hid_service import (
    ASCII_TO_HID,
    HID_BUTTON_STATE_DOWN,
    HID_BUTTON_STATE_UP,
    KEY_BACKSPACE,
    KEY_DOWN,
    KEY_ENTER,
    KEY_ESC,
    KEY_LEFT,
    KEY_LEFT_SHIFT,
    KEY_RIGHT,
    KEY_SPACE,
    KEY_TAB,
    KEY_UP,
    TOUCHSCREEN_STATE_CONTACT,
    TOUCHSCREEN_STATE_RELEASE,
    IndigoHIDService,
    UniversalHIDServiceService,
)
from pymobiledevice3.remote.core_device.display_service import DisplayService
from pymobiledevice3.remote.core_device.screen_stream import open_media_receiver
from pymobiledevice3.remote.native_tunnel import NativeRemotedTunnel

AUTH_SETTLE_S = 0.5      # same settle pymobiledevice3's touch_session uses after starting the stream
STALE_RTP_S = 1.5        # ~120 RTP packets/s arrive even on a static screen; silence means our session is gone


class Stream:
    """A display media stream we own (RTCP keepalive + health) plus the HID service riding on it."""

    def __init__(self, rsd) -> None:
        self.rsd = rsd
        self.display = None
        self.transport = None
        self.hid = None
        self.tasks: list[asyncio.Task] = []
        self.last_rtp = 0.0
        self.seq = 0
        self.ours = 0
        self.dev = 0
        self.dest = None

    async def open(self) -> None:
        ip = self.rsd.service.address[0]
        self.display = DisplayService(self.rsd)
        await self.display.__aenter__()
        self.transport, receiver_ip = open_media_receiver(self.display, (1 * 1024 * 1024,))
        try:
            resp = await asyncio.wait_for(self.display.start_video_stream(
                receiver_ip=receiver_ip, receiver_port=self.transport.port, sender_ip=ip, display_id=1), timeout=10.0)
        except asyncio.TimeoutError as e:
            raise RuntimeError("timed out starting the iPhone screen stream (its media daemon may be wedged: restart the phone)") from e
        cfg = (resp or {}).get("connection", {}).get("streamConfig", {})
        self.ours, self.dev = int(cfg.get("RemoteSSRC", 0)), int(cfg.get("LocalSSRC", 0))
        port = int(cfg.get("SourcePort", 0))
        self.dest = (ip, port) if port else None
        self.last_rtp = time.monotonic()
        self.tasks = [asyncio.create_task(self._drain()), asyncio.create_task(self._keepalive())]
        await asyncio.sleep(AUTH_SETTLE_S)
        self.hid = UniversalHIDServiceService(self.rsd)
        await self.hid.__aenter__()

    async def _drain(self) -> None:
        with contextlib.suppress(asyncio.CancelledError, OSError):
            while True:
                data = await self.transport.recv()
                if len(data) >= 4 and not (200 <= data[1] <= 204):  # RTP, not RTCP
                    self.last_rtp = time.monotonic()
                    self.seq = struct.unpack("!H", data[2:4])[0]

    async def _keepalive(self) -> None:
        if not self.dest:
            return
        with contextlib.suppress(asyncio.CancelledError):
            while True:
                rr = struct.pack("!BBHII BBBB IIII", 0x81, 0xC9, 7, self.ours, self.dev, 0, 0, 0, 0, self.seq, 0, 0, 0)
                sdes = struct.pack("!BBHI BBBB", 0x81, 0xCA, 2, self.ours, 1, 0, 0, 0)
                with contextlib.suppress(Exception):
                    await self.transport.sendto(rr + sdes, *self.dest)
                await asyncio.sleep(1.0)

    def healthy(self) -> bool:
        return self.hid is not None and time.monotonic() - self.last_rtp < STALE_RTP_S

    async def close(self) -> None:
        for t in self.tasks:
            t.cancel()
        for t in self.tasks:
            with contextlib.suppress(BaseException):
                await t
        self.tasks = []
        if self.hid is not None:
            with contextlib.suppress(BaseException):
                await self.hid.__aexit__(None, None, None)
            self.hid = None
        if self.display is not None:
            with contextlib.suppress(Exception):  # only OUR session: Xcode / iPhone Mirroring keep theirs
                await self.display.stop_media_stream(stop_all=False, identifiers=[self.ours])
            with contextlib.suppress(BaseException):
                await self.display.__aexit__(None, None, None)
            self.display = None
        if self.transport is not None:
            with contextlib.suppress(Exception):
                self.transport.close()
            self.transport = None

KEYS = {
    "enter": KEY_ENTER, "return": KEY_ENTER, "delete": KEY_BACKSPACE, "backspace": KEY_BACKSPACE,
    "tab": KEY_TAB, "escape": KEY_ESC, "esc": KEY_ESC, "space": KEY_SPACE,
    "up": KEY_UP, "down": KEY_DOWN, "left": KEY_LEFT, "right": KEY_RIGHT,
}
# Consumer-page (0x0C) hardware buttons: (usage, hold seconds). iOS tells a press from a hold by the hold time.
BUTTONS = {
    "home": (0x40, 0.05), "lock": (0x30, 0.1), "power": (0x30, 0.1),
    "volume_up": (0xE9, 0.05), "volume_down": (0xEA, 0.05), "mute": (0xE2, 0.05), "siri": (0xCF, 1.0),
}


def out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Channel:
    def __init__(self, rsd) -> None:
        self.rsd = rsd
        self.stream = Stream(rsd)
        self.kb: int | None = None
        self.indigo: IndigoHIDService | None = None
        self.reopens = 0

    @property
    def touch(self):
        return self.stream.hid

    async def ensure(self) -> None:
        """Reopen the stream if the phone reaped it or another client replaced it (~0.85 s)."""
        if self.stream.healthy():
            return
        await self.stream.close()
        self.stream = Stream(self.rsd)
        self.kb = None  # the virtual keyboard is registered on the HID service, which we just replaced
        await self.stream.open()
        self.reopens += 1

    async def tap(self, x: int, y: int, hold: float = 0.05) -> None:
        await self.touch.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x, y)
        await asyncio.sleep(hold)
        await self.touch.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x, y)

    async def drag(self, x1: int, y1: int, x2: int, y2: int, seconds: float, fling: bool = False) -> None:
        steps = max(8, min(90, int(seconds * 60)))
        for i in range(steps):
            t = i / steps
            await self.touch.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, round(x1 + (x2 - x1) * t), round(y1 + (y2 - y1) * t))
            await asyncio.sleep(seconds / steps)
        await self.touch.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x2, y2)
        if not fling:
            # Hold still before lifting: zero release velocity, so scroll views stop where the finger stopped
            # instead of flinging past the target (agents need precise, repeatable scrolls).
            for _ in range(4):
                await asyncio.sleep(0.04)
                await self.touch.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x2, y2)
        await self.touch.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x2, y2)

    async def keyboard(self) -> int:
        if self.kb is None:
            self.kb = await self.touch.create_keyboard_service()
        return self.kb

    async def press(self, usages: tuple[int, ...], shift: bool = False) -> None:
        kb = await self.keyboard()
        if shift:  # iOS can ignore Shift arriving together with the key: assert it first
            await self.touch.send_keyboard(kb, (KEY_LEFT_SHIFT,))
            await asyncio.sleep(0.03)
        await self.touch.send_keyboard(kb, ((KEY_LEFT_SHIFT,) if shift else ()) + usages)
        await asyncio.sleep(0.03)
        await self.touch.send_keyboard(kb, ())
        await asyncio.sleep(0.015)

    async def combo(self, mods: list[str], key: str) -> None:
        """Modifier chord, e.g. cmd+v (paste), cmd+a (select all)."""
        bits = {"cmd": 0xE3, "command": 0xE3, "shift": 0xE1, "ctrl": 0xE0, "control": 0xE0, "alt": 0xE2, "option": 0xE2}
        held = tuple(bits[m] for m in mods)
        k = KEYS.get(key) or (ASCII_TO_HID.get(key) or (None,))[0]
        if k is None:
            raise ValueError(f"unknown key {key!r} for combo")
        kb = await self.keyboard()
        await self.touch.send_keyboard(kb, held)
        await asyncio.sleep(0.03)
        await self.touch.send_keyboard(kb, held + (k,))
        await asyncio.sleep(0.04)
        await self.touch.send_keyboard(kb, held)
        await asyncio.sleep(0.02)
        await self.touch.send_keyboard(kb, ())

    async def type(self, text: str) -> None:
        for ch in text:
            m = ASCII_TO_HID.get("\n" if ch == "\r" else ch)
            if m is None:
                raise ValueError(f"unsupported character {ch!r} (ASCII only; use the clipboard for other text)")
            usage, shift = m
            await self.press((usage,), shift)

    async def button(self, name: str) -> None:
        if name not in BUTTONS:
            raise ValueError(f"unknown button {name!r}; one of {', '.join(BUTTONS)}")
        usage, hold = BUTTONS[name]
        if self.indigo is None:
            self.indigo = IndigoHIDService(self.rsd)
            await self.indigo.__aenter__()
        await self.indigo.send_button(0x0C, usage, HID_BUTTON_STATE_DOWN)
        await asyncio.sleep(hold)
        await self.indigo.send_button(0x0C, usage, HID_BUTTON_STATE_UP)


async def handle(ch: Channel, req: dict) -> dict | None:
    cmd = req.get("cmd")
    if cmd == "ping":
        return None
    if cmd == "status":  # no input: stream health, for diagnostics
        return {"healthy": ch.stream.healthy(), "sinceRtpMs": round((time.monotonic() - ch.stream.last_rtp) * 1000), "reopens": ch.reopens}
    if cmd == "ensure":  # no input: reopen the stream if it went stale
        await ch.ensure()
        return {"healthy": ch.stream.healthy(), "reopens": ch.reopens}
    if cmd != "button":  # hardware buttons go through Indigo and don't need the stream
        await ch.ensure()
    if cmd == "tap":
        await ch.tap(int(req["x"]), int(req["y"]))
    elif cmd == "double_tap":
        await ch.tap(int(req["x"]), int(req["y"]))
        await asyncio.sleep(0.08)
        await ch.tap(int(req["x"]), int(req["y"]))
    elif cmd == "hold":
        await ch.tap(int(req["x"]), int(req["y"]), hold=max(0.1, float(req.get("ms", 800)) / 1000))
    elif cmd == "drag":
        await ch.drag(int(req["x1"]), int(req["y1"]), int(req["x2"]), int(req["y2"]), max(0.05, float(req.get("ms", 300)) / 1000), bool(req.get("fling", False)))
    elif cmd == "combo":
        await ch.combo([str(m).lower() for m in req.get("mods", [])], str(req["key"]).lower())
    elif cmd == "type":
        await ch.type(str(req["text"]))
    elif cmd == "key":
        name = str(req["name"]).lower()
        if name not in KEYS:
            raise ValueError(f"unknown key {name!r}; one of {', '.join(KEYS)}")
        await ch.press((KEYS[name],))
    elif cmd == "button":
        await ch.button(str(req["name"]).lower())
    else:
        raise ValueError(f"unknown command {cmd!r}")


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--udid", required=True)
    args = ap.parse_args()
    loop = asyncio.get_running_loop()
    t0 = time.monotonic()
    try:
        async with NativeRemotedTunnel(serial=args.udid) as rsd:
            ch = Channel(rsd)
            try:
                await ch.stream.open()
                out({"event": "ready", "ms": round((time.monotonic() - t0) * 1000)})
                while True:
                    line = await loop.run_in_executor(None, sys.stdin.readline)
                    if not line:
                        return 0
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        req = json.loads(line)
                    except json.JSONDecodeError as e:
                        out({"ok": False, "error": f"bad json: {e}"})
                        continue
                    if req.get("cmd") == "quit":
                        out({"id": req.get("id"), "ok": True})
                        return 0
                    t = time.monotonic()
                    before = ch.reopens
                    try:
                        extra = await handle(ch, req) or {}
                        out({"id": req.get("id"), "ok": True, "ms": round((time.monotonic() - t) * 1000), "reopened": ch.reopens > before, **extra})
                    except (ValueError, KeyError, TypeError) as e:
                        out({"id": req.get("id"), "ok": False, "error": str(e)})
                    except Exception as e:  # connection-level: report, then exit so the caller respawns us
                        out({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}", "fatal": True})
                        return 2
            finally:
                await ch.stream.close()
                if ch.indigo is not None:
                    with contextlib.suppress(BaseException):
                        await ch.indigo.__aexit__(None, None, None)
    except Exception as e:
        out({"event": "failed", "error": f"{type(e).__name__}: {e}", "ms": round((time.monotonic() - t0) * 1000)})
        return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
