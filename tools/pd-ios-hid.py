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

The same stream carries the phone's screen as RTP/HEVC (~60 frames/s, 6 Mbit/s cap). With `--video-fd N` and the
`video` command on, the sidecar depacketizes it (pymobiledevice3's RFC 7798 depacketizer) into access units and writes
them to fd N, so live video and touches share the one stream iOS allows per phone. A lost packet drops its access unit
and the deltas after it until a fresh key frame, which the sidecar asks for with an RTCP PLI (the phone answers in
~40 ms).

Run with the pymobiledevice3 venv's python:  <venv>/bin/python -I -u tools/pd-ios-hid.py --udid <UDID> [--video-fd 3] [--no-steal]

Protocol, JSON lines. Coordinates are already normalised to the HID range 0..65535 by the caller.
  stdin   {"id": 1, "cmd": "tap", "x": 20352, "y": 53832}
  stdout  {"event": "ready", "ms": 1890}          once the stream is open
          {"id": 1, "ok": true, "ms": 60}
          {"id": 1, "ok": false, "error": "..."}
Commands: ping | status | ensure | tap {x,y} | hold {x,y,ms} | drag {x1,y1,x2,y2,ms} | double_tap {x,y} | type {text} | key {name} | combo {mods,key}
          | button {name} | video {on, steal?} | keyframe | quit
  video {on: true}   write access units to the video fd, from the next key frame (which it asks for). A stale stream is
                     reopened, unless steal is false and another client (Xcode Device Hub, iPhone Mirroring, another
                     PhoneDock) streams the phone: then the reply is {"ok": false, "code": "stream_busy"}.
  video {on: false}  stop writing them (the stream stays open for input until the caller quits the sidecar).
  keyframe           ask the phone for a fresh key frame (at most one request per 0.7 s).
--no-steal: when another client streams the phone, don't take the stream at start-up; exit with
            {"event": "failed", "code": "stream_busy"} (a viewer must not take the screen away from Xcode).
A connection-level failure exits the process (code 2); the PhoneDock backend respawns it on the next command.

Video fd records (big-endian):
  u32 length of the rest (16 + payload) | u8 kind | u8 flags | u16 0 | u32 RTP timestamp (24 kHz) | u64 host wall-clock
  microseconds at arrival | payload
  kind 1, one per access unit: flags bit0 key frame, bit1 discontinuity (a new stream, or the first unit after video was
          switched on: decoders reset); payload = the NAL units, each with a 4-byte length prefix (hvcC sample format;
          key units carry VPS/SPS/PPS in-band)
  kind 2, before a key frame whose parameter sets changed: payload = JSON {codec, hvcC, vps, sps, pps} (base64; the
          WebCodecs codec string and hvcC record come from pymobiledevice3)
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import contextlib
import json
import os
import threading
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
from pymobiledevice3.remote.core_device.screen_stream import (
    depacketize_hevc,
    hevc_codec_string_from_sps,
    hevc_decoder_configuration_record,
    open_media_receiver,
)
from pymobiledevice3.remote.native_tunnel import NativeRemotedTunnel

AUTH_SETTLE_S = 0.5      # same settle pymobiledevice3's touch_session uses after starting the stream
STALE_RTP_S = 1.5        # ~120 RTP packets/s arrive even on a static screen; silence means our session is gone
PLI_MIN_S = 0.7          # at most one key-frame request per 0.7 s: a PLI storm stalls the phone's encoder
VIDEO_QUEUE_MAX = 8 << 20  # bytes of access units waiting for the daemon; past it they are dropped (then a key frame)
IRAP = range(16, 22)     # BLA / IDR / CRA NAL types: a decoder can start here


class VideoOut:
    """The binary access-unit channel to the daemon (an inherited pipe fd; stdout stays JSON lines). A writer thread
    keeps a slow reader from ever blocking the event loop that receives RTP and sends touches."""

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.q: collections.deque[bytes] = collections.deque()
        self.queued = 0
        self.cv = threading.Condition()
        self.broken = False
        threading.Thread(target=self._run, name="pd-video-out", daemon=True).start()

    def put(self, rec: bytes) -> bool:
        """Queue one record. False when the reader fell VIDEO_QUEUE_MAX behind: the backlog is dropped."""
        with self.cv:
            if self.broken:
                return False
            if self.queued + len(rec) > VIDEO_QUEUE_MAX:
                self.q.clear()
                self.queued = 0
                return False
            self.q.append(rec)
            self.queued += len(rec)
            self.cv.notify()
        return True

    def _run(self) -> None:
        while True:
            with self.cv:
                while not self.q:
                    self.cv.wait()
                rec = self.q.popleft()
                self.queued -= len(rec)
            view = memoryview(rec)
            try:
                while view:
                    view = view[os.write(self.fd, view):]
            except OSError:
                with self.cv:
                    self.broken = True
                    self.q.clear()
                return


class Video:
    """Turns the stream's RTP into access units on the video fd. Lives on the Channel, so it outlives stream reopens."""

    def __init__(self, out: VideoOut | None) -> None:
        self.out = out
        self.on = False
        self.need_key = True
        self.need_key_since = 0.0
        self.disc = True
        self.units = 0
        self.keys = 0
        self.bytes = 0
        self.lost = 0           # access units dropped for a lost packet or a slow reader
        self.requests = 0       # key frames asked for
        self.params: dict[int, bytes] = {}

    def start(self) -> None:
        self.on = True
        self.restart()

    def restart(self) -> None:
        """A new stream or a new viewer: wait for the next key frame and flag a discontinuity."""
        self.need_key = True
        self.need_key_since = time.monotonic()
        self.disc = True

    def unit(self, stream: "Stream", nals: list[bytes], key: bool, corrupt: bool, rtp_ts: int) -> None:
        if not self.on or self.out is None:
            return
        if corrupt:
            # The deltas after a lost unit reference pixels we never got: hold them back until a fresh key frame.
            self.lost += 1
            if not self.need_key:
                self.need_key = True
                self.need_key_since = time.monotonic()
            stream.request_key()
            return
        if self.need_key and not key:
            if time.monotonic() - self.need_key_since > 1.0:
                stream.request_key()  # the phone ignored (or never got) the last request
            return
        now_us = time.time_ns() // 1000
        if key:
            ps = {(n[0] >> 1) & 0x3F: n for n in nals if ((n[0] >> 1) & 0x3F) in (32, 33, 34)}
            if len(ps) == 3 and (self.disc or ps != self.params):
                self.params = ps
                self.out.put(self.config_record(ps, rtp_ts, now_us))
        payload = b"".join(len(n).to_bytes(4, "big") + n for n in nals)
        flags = (1 if key else 0) | (2 if self.disc else 0)
        rec = struct.pack("!IBBHIQ", 16 + len(payload), 1, flags, 0, rtp_ts & 0xFFFFFFFF, now_us) + payload
        if not self.out.put(rec):
            self.lost += 1
            self.restart()
            stream.request_key()
            return
        self.need_key = False
        self.disc = False
        self.units += 1
        self.keys += 1 if key else 0
        self.bytes += len(payload)

    @staticmethod
    def config_record(ps: dict[int, bytes], rtp_ts: int, now_us: int) -> bytes:
        """Kind-2 record, written just before a key frame whose parameter sets changed: the decoder configuration as
        JSON (WebCodecs codec string and hvcC record from pymobiledevice3, raw VPS/SPS/PPS), all base64."""
        cfg: dict = {k: base64.b64encode(ps[t]).decode() for k, t in (("vps", 32), ("sps", 33), ("pps", 34))}
        with contextlib.suppress(Exception):
            cfg["codec"] = hevc_codec_string_from_sps(ps[33])
        with contextlib.suppress(Exception):
            cfg["hvcC"] = base64.b64encode(hevc_decoder_configuration_record(ps[32], ps[33], ps[34])).decode()
        body = json.dumps(cfg).encode()
        return struct.pack("!IBBHIQ", 16 + len(body), 2, 0, 0, rtp_ts & 0xFFFFFFFF, now_us) + body

    def stats(self) -> dict:
        return {"on": self.on, "units": self.units, "keys": self.keys, "bytes": self.bytes, "lost": self.lost,
                "keyRequests": self.requests, "waitingForKey": self.on and self.need_key}


class Stream:
    """A display media stream we own (RTCP keepalive + health) plus the HID service riding on it."""

    def __init__(self, rsd, video: Video) -> None:
        self.rsd = rsd
        self.video = video
        self.display = None
        self.transport = None
        self.hid = None
        self.tasks: list[asyncio.Task] = []
        self.last_rtp = 0.0
        self.seq = 0
        self.ours = 0
        self.dev = 0
        self.dest = None
        self.last_pli = 0.0

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
        fu = bytearray()
        nals: list[bytes] = []
        au: list[bytes] = []
        key = corrupt = synced = False
        last_seq = 0
        with contextlib.suppress(asyncio.CancelledError, OSError):
            while True:
                data = await self.transport.recv()
                if len(data) < 12 or 200 <= data[1] <= 204:  # RTCP, not RTP
                    continue
                self.last_rtp = time.monotonic()
                self.seq = struct.unpack("!H", data[2:4])[0]
                if not self.video.on:
                    synced = False
                    continue
                marker = data[1] >> 7
                if not synced:  # start at an access-unit boundary, never inside a fragmented NAL
                    synced = bool(marker)
                    last_seq = self.seq
                    fu.clear()
                    au, key, corrupt = [], False, False
                    continue
                if self.seq != (last_seq + 1) & 0xFFFF:
                    fu.clear()           # don't stitch a NAL across a gap
                    corrupt = True
                last_seq = self.seq
                hl = 12 + (data[0] & 0x0F) * 4
                if data[0] & 0x10 and len(data) >= hl + 4:  # header extension
                    hl += 4 + int.from_bytes(data[hl + 2:hl + 4], "big") * 4
                nals.clear()
                depacketize_hevc(data[hl:], fu, nals)
                for n in nals:
                    if n:
                        key = key or ((n[0] >> 1) & 0x3F) in IRAP
                        au.append(n)
                if marker:
                    if au or corrupt:
                        self.video.unit(self, au, key, corrupt, int.from_bytes(data[4:8], "big"))
                    au, key, corrupt = [], False, False

    def request_key(self) -> bool:
        """RTCP PLI (RFC 4585): the phone answers with a fresh key frame (~40 ms over Wi-Fi). Rate-limited."""
        now = time.monotonic()
        if not self.dest or not self.ours or self.transport is None or now - self.last_pli < PLI_MIN_S:
            return False
        self.last_pli = now
        self.video.requests += 1
        pli = struct.pack("!BBHII", 0x81, 0xCE, 2, self.ours, self.dev)
        task = asyncio.ensure_future(self.transport.sendto(pli, *self.dest))
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        return True

    async def foreign_sessions(self) -> list | None:
        """Media-stream sessions on the phone that aren't ours (Xcode Device Hub, iPhone Mirroring, another sidecar).
        None when the phone didn't say (two tries): a caller that must not steal treats that as busy."""
        for attempt in range(2):
            try:
                if self.display is not None:
                    st = await asyncio.wait_for(self.display.get_media_stream_server_status(), 5)
                else:
                    async with DisplayService(self.rsd) as d:
                        st = await asyncio.wait_for(d.get_media_stream_server_status(), 5)
            except Exception:
                if attempt:
                    return None
                await asyncio.sleep(0.3)
                continue
            sessions = (st or {}).get("sessions") or []
            return [x for x in sessions
                    if int(((x.get("connection") or {}).get("streamConfig") or {}).get("RemoteSSRC") or 0) != self.ours]
        return None

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
    def __init__(self, rsd, video_out: VideoOut | None = None) -> None:
        self.rsd = rsd
        self.video = Video(video_out)
        self.stream = Stream(rsd, self.video)
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
        self.stream = Stream(self.rsd, self.video)
        self.kb = None  # the virtual keyboard is registered on the HID service, which we just replaced
        self.video.restart()  # the new stream starts with a key frame; decoders reset
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


async def busy_reason(stream: Stream) -> str | None:
    """Why we must not open a stream now (another client streams, or the phone wouldn't say), else None."""
    foreign = await stream.foreign_sessions()
    if foreign is None:
        return "Couldn't check whether another client is streaming this iPhone's screen"
    if foreign:
        return "Another client (Xcode Device Hub, iPhone Mirroring or another PhoneDock) is streaming this iPhone's screen"
    return None


async def handle(ch: Channel, req: dict) -> dict | None:
    cmd = req.get("cmd")
    if cmd == "ping":
        return None
    if cmd == "status":  # no input: stream health, for diagnostics
        return {"healthy": ch.stream.healthy(), "sinceRtpMs": round((time.monotonic() - ch.stream.last_rtp) * 1000), "reopens": ch.reopens,
                "video": ch.video.stats()}
    if cmd == "ensure":  # no input: reopen the stream if it went stale
        await ch.ensure()
        return {"healthy": ch.stream.healthy(), "reopens": ch.reopens}
    if cmd == "video":
        if not req.get("on"):
            ch.video.on = False
            return {"video": ch.video.stats()}
        if ch.video.out is None:
            raise ValueError("video needs --video-fd")
        if not ch.stream.healthy() and req.get("steal") is False:
            busy = await busy_reason(ch.stream)
            if busy:
                return {"ok": False, "code": "stream_busy", "error": busy}
        await ch.ensure()
        ch.video.start()
        ch.stream.request_key()
        return {"healthy": ch.stream.healthy(), "video": ch.video.stats()}
    if cmd == "keyframe":
        return {"sent": ch.stream.request_key()}
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
    ap.add_argument("--video-fd", type=int, default=None)
    ap.add_argument("--no-steal", action="store_true")
    args = ap.parse_args()
    loop = asyncio.get_running_loop()
    t0 = time.monotonic()
    try:
        async with NativeRemotedTunnel(serial=args.udid) as rsd:
            ch = Channel(rsd, VideoOut(args.video_fd) if args.video_fd is not None else None)
            try:
                busy = await busy_reason(ch.stream) if args.no_steal else None
                if busy:
                    out({"event": "failed", "code": "stream_busy", "ms": round((time.monotonic() - t0) * 1000), "error": busy})
                    return 3
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
